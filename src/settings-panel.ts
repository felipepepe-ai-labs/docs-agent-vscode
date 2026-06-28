import * as vscode from 'vscode';
import { assertSafeUrl } from './ollama';

interface OllamaModel { name: string }

export class SettingsPanel {
  private static instance: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(ctx: vscode.ExtensionContext): void {
    if (SettingsPanel.instance) {
      SettingsPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    SettingsPanel.instance = new SettingsPanel(ctx);
  }

  private constructor(ctx: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'docsAgentSettings',
      'Docs Agent — Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
      }
    );

    this.panel.webview.html = this.buildHtml(ctx);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    this.panel.onDidDispose(() => { SettingsPanel.instance = undefined; this.dispose(); }, null, this.disposables);

    this.sendInit();
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  private sendInit(): void {
    const cfg = vscode.workspace.getConfiguration('docsAgent');
    this.panel.webview.postMessage({
      type: 'init',
      settings: {
        provider:       cfg.get<string>('provider',       'ollama'),
        ollamaUrl:      cfg.get<string>('ollamaUrl',      'http://localhost:11434'),
        model:          cfg.get<string>('model',          'qwen3:35b'),
        vscodeLmFamily: cfg.get<string>('vscodeLmFamily', ''),
        docsFolder:     cfg.get<string>('docsFolder',     'docs'),
        language:       cfg.get<string>('language',       'english'),
      },
    });
  }

  // ── Messages ─────────────────────────────────────────────────────────────────

  private onMessage(msg: { type: string; [k: string]: unknown }): void {
    const handler = async (): Promise<void> => {
      switch (msg.type) {
        case 'save':              await this.save(msg['settings'] as Record<string, string>); break;
        case 'testOllama':        await this.testOllama(msg['url'] as string);                break;
        case 'refreshOllama':     await this.fetchOllamaModels(msg['url'] as string);         break;
        case 'listVsCodeModels':  await this.listVsCodeModels();                              break;
      }
    };
    handler().catch(err => {
      vscode.window.showErrorMessage(`Docs Agent Settings: ${(err as Error).message}`);
    });
  }

  private async save(settings: Record<string, string>): Promise<void> {
    const cfg    = vscode.workspace.getConfiguration('docsAgent');
    const target = vscode.ConfigurationTarget.Workspace;
    await cfg.update('provider',       settings['provider'],       target);
    await cfg.update('ollamaUrl',      settings['ollamaUrl'],      target);
    await cfg.update('model',          settings['model'],          target);
    await cfg.update('vscodeLmFamily', settings['vscodeLmFamily'], target);
    await cfg.update('docsFolder',     settings['docsFolder'],     target);
    await cfg.update('language',       settings['language'],       target);
  }

  private async testOllama(url: string): Promise<void> {
    try {
      assertSafeUrl(url);
      const resp = await fetch(`${url}/api/version`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as { version?: string };
      this.panel.webview.postMessage({ type: 'testResult', ok: true, version: data.version });
    } catch (err) {
      this.panel.webview.postMessage({ type: 'testResult', ok: false, error: (err as Error).message });
    }
  }

  private async fetchOllamaModels(url: string): Promise<void> {
    try {
      assertSafeUrl(url);
      const resp = await fetch(`${url}/api/tags`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as { models?: OllamaModel[] };
      const names = (data.models ?? []).map(m => m.name);
      this.panel.webview.postMessage({ type: 'ollamaModels', models: names });
    } catch (err) {
      this.panel.webview.postMessage({ type: 'ollamaModels', models: [], error: (err as Error).message });
    }
  }

  private async listVsCodeModels(): Promise<void> {
    try {
      const models = await vscode.lm.selectChatModels();
      const items  = models.map(m => ({ id: m.id, family: m.family, name: m.name, vendor: m.vendor }));
      this.panel.webview.postMessage({ type: 'vsCodeModels', models: items });
    } catch (err) {
      this.panel.webview.postMessage({ type: 'vsCodeModels', models: [], error: (err as Error).message });
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────────

  private buildHtml(ctx: vscode.ExtensionContext): string {
    const webview   = this.panel.webview;
    const nonce     = randomNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'settings-panel.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'settings-panel.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Docs Agent Settings</title>
</head>
<body>
  <h1>⚙ Docs Agent — Settings</h1>

  <!-- Provider selector -->
  <div class="section">
    <label>LLM Provider</label>
    <div class="provider-toggle">
      <label class="radio-label">
        <input type="radio" name="provider" value="ollama">
        <span class="radio-box">
          <strong>Ollama</strong>
          <small>Local model via Ollama</small>
        </span>
      </label>
      <label class="radio-label">
        <input type="radio" name="provider" value="vscode-lm">
        <span class="radio-box">
          <strong>VS Code / Copilot</strong>
          <small>Model selected in Copilot chat</small>
        </span>
      </label>
    </div>
  </div>

  <hr>

  <!-- Ollama section -->
  <div id="section-ollama">
    <div class="section">
      <label for="ollamaUrl">Ollama URL</label>
      <div class="field-row">
        <input id="ollamaUrl" type="text" placeholder="http://localhost:11434" />
        <button id="testOllama" class="secondary">Test</button>
      </div>
    </div>
    <div class="section">
      <label for="model">Model</label>
      <div class="field-row">
        <input id="model" type="text" list="model-list" placeholder="qwen3:35b" />
        <button id="refreshOllama" class="secondary">↺ List</button>
      </div>
      <datalist id="model-list"></datalist>
      <p class="hint">Click ↺ List to fetch installed Ollama models.</p>
    </div>
  </div>

  <!-- VS Code LM section -->
  <div id="section-vscode">
    <div class="section">
      <label for="vscodeLmFamily">Model family <span class="optional">(optional)</span></label>
      <div class="field-row">
        <input id="vscodeLmFamily" type="text" list="vscode-model-list"
          placeholder="e.g. gpt-4o, claude-3.5-sonnet — empty = first available" />
        <button id="listVsCode" class="secondary">↺ List</button>
      </div>
      <datalist id="vscode-model-list"></datalist>
      <p class="hint">
        Leave empty to use the first model VS Code offers (usually the one active in Copilot chat).
        Click ↺ List to see all available models.
      </p>
    </div>
  </div>

  <hr>

  <div class="section">
    <label for="docsFolder">Docs output folder</label>
    <input id="docsFolder" type="text" placeholder="docs" />
    <p class="hint">Workspace-relative path where generated <code>.md</code> files are written.</p>
  </div>

  <div class="section">
    <label for="language">Documentation language</label>
    <select id="language">
      <option value="english">English</option>
      <option value="spanish">Spanish</option>
    </select>
    <p class="hint">Language used for all generated documentation content.</p>
  </div>

  <div class="actions">
    <button id="save" class="primary">Save</button>
  </div>

  <div id="status" class="status"></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

function randomNonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
