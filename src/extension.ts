import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildContext, formatContextBundle } from './context';
import { DOC_TYPES } from './doctypes';
import { CodeGraph, ImpactSummary } from './graph';
import { buildGraph } from './indexer';
import { chat, getLlmConfig } from './llm';
import { GraphPanel } from './panel';
import { buildProjectContext } from './project-context';
import { SettingsPanel } from './settings-panel';
import { OUTPUT_SCHEMA_INSTRUCTION, renderMarkdown, validateAndParse } from './schema';
import { openDoc, writeDoc } from './writer';

const PRIMERS_DIR = path.join(__dirname, '..', 'src', 'primers');
let codeGraph: CodeGraph | null = null;

function loadPrimer(filePath: string): string {
  if (filePath.endsWith('.java')) return loadPrimerFile('springboot.md');
  if (filePath.endsWith('.cs')) return loadPrimerFile('webforms.md');
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
  // Build the workspace graph in the background — does not block activation.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    setImmediate(() => {
      codeGraph = buildGraph(workspaceRoot);
      console.log(`[Docs Agent] Graph ready — ${codeGraph.nodeCount} nodes, ${codeGraph.edgeCount} edges`);
    });
  }

  const command = vscode.commands.registerCommand('docsAgent.documentFile', async () => {
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
          const ctx = buildContext(filePath, workspaceRoot);
          const codeBundle = formatContextBundle(ctx);

          progress.report({ message: 'Loading architectural primer...' });
          const primer = loadPrimer(filePath);

          const systemPrompt = [primer, OUTPUT_SCHEMA_INSTRUCTION].filter(Boolean).join('\n\n---\n\n');

          const userPrompt = `Document the following source files. Use ONLY what is present in the code below.
For every entry you emit, "file" must match one of the // FILE: paths exactly, and "line" must be the 1-based line number of the symbol declaration.

${codeBundle}`;

          const config = getLlmConfig();
          const providerLabel = config.provider === 'vscode-lm' ? 'VS Code LM' : 'Ollama';
          progress.report({ message: `Calling ${providerLabel}...` });
          const raw = await chat(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            config
          );

          progress.report({ message: 'Validating citations...' });
          const result = validateAndParse(raw);

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
          const outputPath = writeDoc(markdown, filePath, workspaceRoot);

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

  const graphCommand = vscode.commands.registerCommand('docsAgent.showGraph', () => {
    if (!codeGraph) {
      vscode.window.showWarningMessage('Docs Agent: Graph is still building. Try again in a moment.');
      return;
    }
    GraphPanel.createOrShow(context, codeGraph);
  });

  const analyzeCommand = vscode.commands.registerCommand('docsAgent.analyzeImpact', async () => {
    if (!codeGraph) {
      vscode.window.showWarningMessage('Docs Agent: Graph is still building. Try again in a moment.');
      return;
    }

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
  });

  const settingsCommand = vscode.commands.registerCommand('docsAgent.openSettings', () => {
    SettingsPanel.createOrShow(context);
  });

  const projectCommand = vscode.commands.registerCommand('docsAgent.documentProject', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
          const ctx    = buildProjectContext(root);
          const config = getLlmConfig();
          const docsFolder = vscode.workspace.getConfiguration('docsAgent').get<string>('docsFolder', 'docs');

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
              const content = await chat(
                [
                  { role: 'system', content: system },
                  { role: 'user',   content: user   },
                ],
                config,
                token
              );

              // README lives at workspace root; everything else goes flat into docsFolder
              const filename = path.basename(docType.outputPath);
              const relOut   = filename === 'README.md' ? filename : `${docsFolder}/${filename}`;
              const absOut  = path.join(root, relOut);
              fs.mkdirSync(path.dirname(absOut), { recursive: true });
              fs.writeFileSync(absOut, content, 'utf8');
              generated.push(relOut);
            } catch (err) {
              const msg = (err as Error).message;
              if (msg.includes('Cancelled') || msg.includes('cancel')) break;
              vscode.window.showWarningMessage(`Docs Agent: Failed to generate "${docType.label}" — ${msg}`);
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

  context.subscriptions.push(command, analyzeCommand, graphCommand, settingsCommand, projectCommand);
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

export function deactivate() {}
