import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildContext, buildContextFiles, buildContextWithCbm, formatContextBundle } from './context';
import { CbmManager, createCbmManager, isCbmAlive } from './cbm-runner';
import { DOC_TYPES } from './doctypes';
import { DashboardPanel } from './dashboard-panel';
import { CodeGraph, ImpactSummary, fromCbmQuery } from './graph';
import { ArchitectureData, buildGraphContextForDoc } from './graph-context';
import { chat, getLlmConfig, setActiveCommand } from './llm';
import { GraphPanel } from './panel';
import { buildProjectContext } from './project-context';
import { SettingsPanel } from './settings-panel';
import { OUTPUT_SCHEMA_INSTRUCTION, renderMarkdown, validateAndParse, verifyCitationsAgainstGraph } from './schema';
import { normalizeMermaidBlocks, openDoc, writeDoc } from './writer';

const PRIMERS_DIR = path.join(__dirname, '..', 'src', 'primers');
let codeGraph: CodeGraph | null = null;
// One CbmManager per workspace root. Empty when CBM is not installed — graph stays empty.
const cbmManagers = new Map<string, CbmManager>();
let cbmStatusBarItem: vscode.StatusBarItem | undefined;

// Reflects whether Docs Agent is actually getting graph-enriched context, not just
// whether the CBM server process is reachable — isCbmAlive() only checks the latter.
function updateCbmStatusBar(state: 'offline' | 'reachable', unindexedRoots: string[]): void {
  if (!cbmStatusBarItem) return;

  if (state === 'offline') {
    cbmStatusBarItem.text = '$(circle-slash) Docs Agent: CBM offline';
    cbmStatusBarItem.tooltip =
      'codebase-memory-mcp is not reachable. Docs Agent is using filesystem-only context — ' +
      'no call-graph enrichment, IMPLEMENTS resolution, or graph-verified citations.';
    cbmStatusBarItem.show();
    return;
  }

  if (unindexedRoots.length > 0) {
    const names = unindexedRoots.map(r => path.basename(r)).join(', ');
    cbmStatusBarItem.text = '$(warning) Docs Agent: CBM not indexed';
    cbmStatusBarItem.tooltip =
      `codebase-memory-mcp is running but has not finished indexing: ${names}. ` +
      'Docs Agent is using filesystem-only context for these until indexing completes.';
    cbmStatusBarItem.show();
    return;
  }

  cbmStatusBarItem.hide();
}

function languageInstruction(language: string): string {
  if (language === 'spanish') {
    return 'Write the entire document in Spanish. All prose, headings, labels, and descriptions must be in Spanish. Code identifiers, file paths, and technical keywords used as identifiers may remain in English.';
  }
  return '';
}

function loadPrimer(filePath: string, workspaceRoot: string): string {
  if (filePath.endsWith('.java'))  return loadPrimerFile('springboot.md');
  if (filePath.endsWith('.cs'))    return loadPrimerFile('webforms.md');
  if (filePath.endsWith('.ts') && !filePath.endsWith('.spec.ts')) {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = fs.readFileSync(pkgPath, 'utf8');
        if (pkg.includes('"@angular/core"')) return loadPrimerFile('angular.md');
      } catch { /* ignore */ }
    }
  }
  return '';
}

function loadPrimerFile(name: string): string {
  const primerPath = path.join(PRIMERS_DIR, name);
  if (fs.existsSync(primerPath)) {
    return fs.readFileSync(primerPath, 'utf8');
  }
  return '';
}

export function activate(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots   = folders.map(f => f.uri.fsPath);

  cbmStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  cbmStatusBarItem.command = 'docsAgent.showDashboard';
  context.subscriptions.push(cbmStatusBarItem);

  if (roots.length > 0) {
    void initGraph(context, roots);
  }

  context.subscriptions.push(
    registerDocumentFileCommand(),
    registerAnalyzeImpactCommand(),
    registerShowGraphCommand(context, roots),
    registerSettingsCommand(context),
    registerDocumentProjectCommand(),
    registerDashboardCommand(context, roots)
  );
}

function registerDocumentFileCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('docsAgent.documentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Docs Agent: No active file.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Docs Agent: File must be inside a workspace.');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Docs Agent: Documenting ${path.basename(filePath)}...`,
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ message: 'Reading file and dependencies...' });
          const cbm = cbmManagers.get(workspaceRoot);
          const ctx = cbm
            ? await buildContextWithCbm(filePath, workspaceRoot, cbm)
            : buildContext(filePath, workspaceRoot);
          const contextFiles = buildContextFiles(ctx);
          const codeBundle = formatContextBundle(ctx);

          progress.report({ message: 'Loading architectural primer...' });
          const primer = loadPrimer(filePath, workspaceRoot);

          const systemPrompt = [primer, OUTPUT_SCHEMA_INSTRUCTION].filter(Boolean).join('\n\n---\n\n');

          const userPrompt = `Document the following source files. Use ONLY what is present in the code below.
For every entry you emit, "file" must match one of the // FILE: paths exactly, and "line" must be the 1-based line number of the symbol declaration.

${codeBundle}`;

          const config   = getLlmConfig();
          const language = vscode.workspace.getConfiguration('docsAgent').get<string>('language', 'english');
          const langNote = languageInstruction(language);
          const fullSystemPrompt = langNote ? `${systemPrompt}\n\n---\n\n${langNote}` : systemPrompt;

          const providerLabel = config.provider === 'vscode-lm' ? 'VS Code LM' : 'Ollama';
          progress.report({ message: `Calling ${providerLabel}...` });
          setActiveCommand('documentFile');
          const raw = await chat(
            [
              { role: 'system', content: fullSystemPrompt },
              { role: 'user', content: userPrompt },
            ],
            config
          );

          progress.report({ message: 'Validating citations...' });
          let result = validateAndParse(raw, contextFiles);
          if (cbm) {
            try {
              result = await verifyCitationsAgainstGraph(result, cbm);
            } catch { /* graph verification failed — keep the base validation result */ }
          }

          if (result.valid.length === 0 && result.rejected.length > 0) {
            vscode.window.showErrorMessage(
              `Docs Agent: All ${result.rejected.length} entries were rejected (missing citations). Check the model output.`
            );
            return;
          }

          const lookupImpact = codeGraph
            ? (sym: string) => codeGraph!.queryImpact(sym)
            : undefined;
          const markdown = renderMarkdown(result, filePath, lookupImpact);
          const modelLabel = config.provider === 'vscode-lm'
            ? `VS Code LM${config.vscodeLmFamily ? ` / ${config.vscodeLmFamily}` : ''}`
            : `${config.ollamaModel} / Ollama`;
          const outputPath = writeDoc(markdown, filePath, workspaceRoot, modelLabel);

          const summary =
            result.rejected.length > 0
              ? `✓ ${result.valid.length} entries documented. ⚠️ ${result.rejected.length} rejected (missing citations).`
              : `✓ ${result.valid.length} entries documented with full citation coverage.`;

          const choice = await vscode.window.showInformationMessage(summary, 'Open docs');
          if (choice === 'Open docs') {
            await openDoc(outputPath);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Docs Agent: ${(err as Error).message}`);
        }
      }
    );
  });
}

function registerShowGraphCommand(context: vscode.ExtensionContext, roots: string[]): vscode.Disposable {
  return vscode.commands.registerCommand('docsAgent.showGraph', () => {
    if (!codeGraph) {
      vscode.window.showWarningMessage('Docs Agent: Graph is still building. Try again in a moment.');
      return;
    }
    // Pass the CBM manager for the first workspace root, if available
    const cbm = roots.length > 0 ? cbmManagers.get(roots[0]) : undefined;
    GraphPanel.createOrShow(context, codeGraph, cbm);
  });
}

function registerAnalyzeImpactCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('docsAgent.analyzeImpact', async () => {
    if (!codeGraph) {
      vscode.window.showWarningMessage('Docs Agent: Graph is still building. Try again in a moment.');
      return;
    }

    try {
      const editor = vscode.window.activeTextEditor;
      const wordRange = editor?.document.getWordRangeAtPosition(editor.selection.active);
      const wordUnderCursor = wordRange ? editor!.document.getText(wordRange) : '';

      const symbolName = await vscode.window.showInputBox({
        value: wordUnderCursor,
        prompt: 'Symbol to analyze — class name, method name, or ClassName.methodName',
        placeHolder: 'e.g.  OrderService  or  OrderService.confirm',
      });
      if (!symbolName) return;

      const impact = codeGraph.queryImpact(symbolName);
      const markdown = renderImpactDoc(symbolName, impact, codeGraph.nodeCount, codeGraph.edgeCount);
      const doc = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Docs Agent: ${(err as Error).message}`);
    }
  });
}

function registerSettingsCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('docsAgent.openSettings', () => {
    SettingsPanel.createOrShow(context);
  });
}

function registerDocumentProjectCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('docsAgent.documentProject', async () => {
    const root = await pickWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage('Docs Agent: Open a workspace folder first.');
      return;
    }

    // Build QuickPick items grouped by category
    const categories = [...new Set(DOC_TYPES.map(d => d.category))];
    const items: vscode.QuickPickItem[] = [];
    for (const cat of categories) {
      items.push({ label: cat, kind: vscode.QuickPickItemKind.Separator });
      for (const doc of DOC_TYPES.filter(d => d.category === cat)) {
        items.push({ label: doc.label, description: doc.detail, picked: true });
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select documents to generate (all selected by default)',
      title:       'Docs Agent — Project Documentation Suite',
    });
    if (!selected || selected.length === 0) return;

    const selectedLabels = new Set(
      selected
        .filter(s => s.kind !== vscode.QuickPickItemKind.Separator)
        .map(s => s.label)
    );
    const chosenTypes = DOC_TYPES.filter(d => selectedLabels.has(d.label));

    await vscode.window.withProgress(
      {
        location:    vscode.ProgressLocation.Notification,
        title:       'Docs Agent: Generating project documentation…',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          progress.report({ message: 'Scanning workspace…', increment: 0 });
          const cbmForRoot = cbmManagers.get(root);
          const ctx      = await buildProjectContext(root, cbmForRoot);
          const config   = getLlmConfig();
          const cfg      = vscode.workspace.getConfiguration('docsAgent');
          const docsFolder = cfg.get<string>('docsFolder', 'docs');
          const language   = cfg.get<string>('language', 'english');
          const langNote   = languageInstruction(language);

          // Fetch the full architecture once; each doc type below selects its own
          // relevant slice (+ targeted queries) instead of receiving the same dump.
          let architecture: ArchitectureData = {};
          if (cbmForRoot) {
            try {
              progress.report({ message: 'Fetching architecture overview…', increment: 0 });
              architecture = JSON.parse(await cbmForRoot.getArchitecture(['all'])) as ArchitectureData;
            } catch (err) {
              console.warn('[Docs Agent] Architecture fetch failed:', err);
            }
          }

          const increment = 90 / chosenTypes.length;
          const generated: string[] = [];

          for (let i = 0; i < chosenTypes.length; i++) {
            if (token.isCancellationRequested) break;

            const docType = chosenTypes[i];
            progress.report({
              message:   `(${i + 1}/${chosenTypes.length}) ${docType.label}…`,
              increment: i === 0 ? 10 : increment,
            });

            try {
              const { system, user } = docType.prompt(ctx);
              const graphContext = cbmForRoot
                ? await buildGraphContextForDoc(architecture, cbmForRoot, docType.id)
                : '';
              const systemWithArch = graphContext
                ? `${system}\n\n---\n## Code Graph Analysis\n\n${graphContext}`
                : system;
              const systemWithLang = langNote ? `${systemWithArch}\n\n---\n\n${langNote}` : systemWithArch;
              setActiveCommand('documentProject');
              const content = await chat(
                [
                  { role: 'system', content: systemWithLang },
                  { role: 'user',   content: user           },
                ],
                config,
                token
              );

              // README lives at workspace root; everything else goes flat into docsFolder
              const filename = path.basename(docType.outputPath);
              const relOut   = filename === 'README.md' ? filename : `${docsFolder}/${filename}`;
              const absOut   = path.resolve(root, relOut);
              if (!absOut.startsWith(path.resolve(root) + path.sep) && absOut !== path.resolve(root)) {
                throw new Error(`docsFolder setting points outside the workspace root: ${docsFolder}`);
              }
              fs.mkdirSync(path.dirname(absOut), { recursive: true });
              fs.writeFileSync(absOut, normalizeMermaidBlocks(content), 'utf8');
              generated.push(relOut);
            } catch (err) {
              if (token.isCancellationRequested || err instanceof vscode.CancellationError) break;
              vscode.window.showWarningMessage(`Docs Agent: Failed to generate "${docType.label}" — ${(err as Error).message}`);
            }
          }

          if (generated.length === 0) return;

          const summary = `✓ ${generated.length} document(s) written to ${docsFolder}/`;
          const choice  = await vscode.window.showInformationMessage(summary, 'Open folder');
          if (choice === 'Open folder') {
            const folderUri = vscode.Uri.file(path.join(root, docsFolder));
            await vscode.commands.executeCommand('revealInExplorer', folderUri);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Docs Agent: ${(err as Error).message}`);
        }
      }
    );
  });
}

function registerDashboardCommand(context: vscode.ExtensionContext, roots: string[]): vscode.Disposable {
  return vscode.commands.registerCommand('docsAgent.showDashboard', () => {
    if (!codeGraph) {
      vscode.window.showWarningMessage('Docs Agent: Graph is still building. Try again in a moment.');
      return;
    }
    DashboardPanel.createOrShow(context, codeGraph, roots);
  });
}

function renderImpactDoc(symbol: string, impact: ImpactSummary, nodes: number, edges: number): string {
  const lines: string[] = [
    `# Impact Analysis: \`${symbol}\``,
    '',
    `> Docs Agent graph — ${nodes} nodes · ${edges} edges · ${new Date().toLocaleString()}`,
    '',
  ];

  if (impact.implementors.length > 0) {
    lines.push('## Implementors');
    lines.push('');
    for (const impl of impact.implementors) lines.push(`- \`${impl}\``);
    lines.push('');
  }

  if (impact.consumers.length > 0) {
    lines.push('## Consumers (classes that inject this)');
    lines.push('');
    for (const c of impact.consumers) lines.push(`- \`${c.symbol}\` — field \`${c.fieldName}\``);
    lines.push('');
  }

  if (impact.callers.length > 0) {
    lines.push('## Callers');
    lines.push('');
    for (const c of impact.callers) {
      const shortFile = c.file.split('/').slice(-2).join('/');
      lines.push(`- \`${c.symbol}\` — ${shortFile}:${c.line}`);
    }
    lines.push('');
  }

  if (impact.tableRefs.length > 0) {
    lines.push('## SQL Table References');
    lines.push('');
    for (const t of impact.tableRefs) {
      const shortFile = t.file.split('/').slice(-2).join('/');
      lines.push(`- \`${t.table}\` (${t.operation}) — \`${t.symbol}\` at ${shortFile}:${t.line}`);
    }
    lines.push('');
  }

  const total = impact.callers.length + impact.implementors.length +
    impact.consumers.length + impact.tableRefs.length;
  if (total === 0) {
    lines.push('*No references found in the indexed workspace.*');
    lines.push('');
  }

  return lines.join('\n');
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

async function initGraph(ctx: vscode.ExtensionContext, roots: string[]): Promise<void> {
  const cfg  = vscode.workspace.getConfiguration('docsAgent');
  const port = cfg.get<number>('cbmPort', 9749);

  // Primary path: codebase-memory-mcp (already running, connect via HTTP)
  if (await isCbmAlive(port)) {
    await initCbm(ctx, roots, port);
    return;
  }

  // No CBM available — graph stays empty. Code graph features will show 0 nodes/edges.
  codeGraph = new CodeGraph();
  console.log('[Docs Agent] Graph: no CBM available — empty graph (0 nodes)');
  updateCbmStatusBar('offline', []);
}

async function initCbm(ctx: vscode.ExtensionContext, roots: string[], port: number): Promise<void> {
  // Register managers — HTTP is stateless so dispose is a no-op, but we register
  // for symmetry so ctx.subscriptions cleanup works uniformly.
  for (const root of roots) {
    const mgr = createCbmManager(root, port);
    cbmManagers.set(root, mgr);
    ctx.subscriptions.push({ dispose: () => mgr.dispose() });
  }

  // isCbmAlive only confirms the server process is reachable — it says nothing
  // about whether *this* project has been indexed, so check each root explicitly.
  const unindexedRoots = (
    await Promise.all(
      [...cbmManagers].map(async ([root, mgr]) => (await mgr.indexStatus()).indexed ? null : root),
    )
  ).filter((r): r is string => r !== null);
  updateCbmStatusBar('reachable', unindexedRoots);

  // Load graph in background — CBM indexes automatically, we just query it.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Docs Agent' },
    async (progress) => {
      try {
        progress.report({ message: 'Loading code graph from CBM…' });
        const merged = new CodeGraph();
        for (const [root, mgr] of cbmManagers) {
          merged.merge(await fromCbmQuery(mgr, root));
        }
        codeGraph = merged;
        DashboardPanel.updateGraph(codeGraph);
        console.log(`[Docs Agent] CBM graph loaded — ${codeGraph.nodeCount} nodes, ${codeGraph.edgeCount} edges`);
      } catch (err) {
        console.error('[Docs Agent] CBM graph load failed:', err);
        vscode.window.showWarningMessage(`Docs Agent: CBM graph load failed — ${(err as Error).message}`);
      }
    },
  );
}

// Returns the single workspace root, or prompts the user to pick one when
// there are multiple folders open.
async function pickWorkspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0].uri.fsPath;

  const activeFolder = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    : undefined;

  const items = folders.map(f => ({
    label:       f.name,
    description: f.uri.fsPath,
    picked:      f === activeFolder,
    fsPath:      f.uri.fsPath,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select which project to document',
    title:       'Docs Agent — Select Project',
  });

  return picked?.fsPath;
}

export function deactivate() {
  for (const mgr of cbmManagers.values()) mgr.dispose();
  cbmManagers.clear();
}
