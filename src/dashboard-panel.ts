import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeGraph } from './graph';
import { getTokenRecords, getTokenTotals } from './token-store';

type InMessage =
  | { type: 'refresh' }
  | { type: 'search';   query:  string }
  | { type: 'inspect';  nodeId: string }
  | { type: 'openFile'; file:   string; line?: number };

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private graph: CodeGraph;
  private readonly roots: string[];
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(ctx: vscode.ExtensionContext, graph: CodeGraph, roots: string[]): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.One);
      DashboardPanel.instance.graph = graph;
      DashboardPanel.instance.pushAll();
      return;
    }
    DashboardPanel.instance = new DashboardPanel(ctx, graph, roots);
  }

  static updateGraph(graph: CodeGraph): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.graph = graph;
      DashboardPanel.instance.pushAll();
    }
  }

  private constructor(ctx: vscode.ExtensionContext, graph: CodeGraph, roots: string[]) {
    this.graph = graph;
    this.roots = roots;

    this.panel = vscode.window.createWebviewPanel(
      'docsAgentDashboard',
      'Docs Agent — Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts:          true,
        retainContextWhenHidden: true,
        localResourceRoots:     [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
      },
    );

    this.panel.webview.html = this.buildHtml(ctx);

    this.panel.webview.onDidReceiveMessage(
      (msg: InMessage) => this.onMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => {
      DashboardPanel.instance = undefined;
      this.dispose();
    }, null, this.disposables);

    this.pushAll();
  }

  // ── Outgoing ──────────────────────────────────────────────────────────────

  private pushAll(): void {
    this.pushStats();
    this.pushCommunities();
    this.pushTokenUsage();
  }

  private pushStats(): void {
    // Compute per-node degree for hotspot ranking.
    const degree = new Map<string, number>();
    for (const id of this.graph.nodes.keys()) degree.set(id, 0);
    const bump = (id: string) => { if (degree.has(id)) degree.set(id, degree.get(id)! + 1); };

    for (const e of this.graph.callEdges) {
      bump(e.caller);
      // callee stored as simple name — bump all matching nodes
      for (const [id] of this.graph.nodes) {
        if (id === e.callee || id.endsWith('.' + e.callee)) bump(id);
      }
    }
    for (const e of this.graph.implementsEdges) { bump(e.implementor); bump(e.contract); }
    for (const e of this.graph.injectsEdges)    { bump(e.consumer);    bump(e.dependency); }
    for (const e of this.graph.tableEdges)       bump(e.symbol);

    const hotspots = [...this.graph.nodes.values()]
      .sort((a, b) => (degree.get(b.symbol) ?? 0) - (degree.get(a.symbol) ?? 0))
      .slice(0, 10)
      .map(n => ({
        id:     n.symbol,
        label:  n.label ?? n.symbol.split('.').pop() ?? n.symbol,
        kind:   n.kind,
        degree: degree.get(n.symbol) ?? 0,
      }));

    this.panel.webview.postMessage({
      type:             'stats',
      nodeCount:        this.graph.nodeCount,
      edgeCount:        this.graph.edgeCount,
      callEdges:        this.graph.callEdges.length,
      implementsEdges:  this.graph.implementsEdges.length,
      injectsEdges:     this.graph.injectsEdges.length,
      tableEdges:       this.graph.tableEdges.length,
      hotspots,
    });
  }

  private pushCommunities(): void {
    const map = new Map<number, { name: string; nodes: { id: string; label: string; kind: string }[] }>();

    for (const n of this.graph.nodes.values()) {
      // Group by first segment (package / top-level module name) as fallback community.
      const communityId   = 0;
      const communityName = n.symbol.includes('.')
        ? n.symbol.split('.')[0]
        : 'default';

      // Group by first segment (package / top-level module name)
      const key = communityName;
      const idx = key.charCodeAt(0) % 1000; // stable numeric id per name
      if (!map.has(idx)) map.set(idx, { name: key, nodes: [] });
      map.get(idx)!.nodes.push({
        id:    n.symbol,
        label: n.label ?? n.symbol.split('.').pop() ?? n.symbol,
        kind:  n.kind,
      });
    }

    const communities = [...map.values()]
      .sort((a, b) => b.nodes.length - a.nodes.length)
      .map(c => ({ name: c.name, size: c.nodes.length, topNodes: c.nodes.slice(0, 5) }));

    this.panel.webview.postMessage({ type: 'communities', communities });
  }

  private pushTokenUsage(): void {
    this.panel.webview.postMessage({
      type:    'tokenUsage',
      records: getTokenRecords(),
      totals:  getTokenTotals(),
    });
  }

  // ── Incoming ──────────────────────────────────────────────────────────────

  private onMessage(msg: InMessage): void {
    switch (msg.type) {
      case 'refresh':     this.pushAll();                              break;
      case 'search':      this.sendSearchResults(msg.query);          break;
      case 'inspect':     this.sendSymbolDetail(msg.nodeId);          break;
      case 'openFile':    void this.openFile(msg.file, msg.line);     break;
    }
  }

  private sendSearchResults(query: string): void {
    const q = query.toLowerCase();
    const results = [...this.graph.nodes.values()]
      .filter(n => n.symbol.toLowerCase().includes(q) || (n.label ?? '').toLowerCase().includes(q))
      .slice(0, 20)
      .map(n => ({
        id:    n.symbol,
        label: n.label ?? n.symbol.split('.').pop() ?? n.symbol,
        kind:  n.kind,
        file:  n.file,
        line:  n.line,
      }));
    this.panel.webview.postMessage({ type: 'searchResults', results });
  }

  private sendSymbolDetail(nodeId: string): void {
    const impact = this.graph.queryImpact(nodeId);
    const node   = this.graph.nodes.get(nodeId);
    this.panel.webview.postMessage({
      type:   'symbolDetail',
      nodeId,
      label:  node?.label ?? nodeId.split('.').pop() ?? nodeId,
      file:   node?.file,
      line:   node?.line,
      kind:   node?.kind,
      callers:      impact.callers,
      tableRefs:    impact.tableRefs,
      implementors: impact.implementors,
      consumers:    impact.consumers,
    });
  }

  private async openFile(file: string, line?: number): Promise<void> {
    let realPath: string;
    try { realPath = fs.realpathSync(file); }
    catch { vscode.window.showErrorMessage(`Docs Agent: Cannot resolve path: ${file}`); return; }

    const inWorkspace = (vscode.workspace.workspaceFolders ?? []).some(f => {
      const root = f.uri.fsPath;
      return realPath === root || realPath.startsWith(root + path.sep);
    });
    if (!inWorkspace) {
      vscode.window.showErrorMessage(`Docs Agent: File is outside the workspace: ${file}`);
      return;
    }
    const doc       = await vscode.workspace.openTextDocument(vscode.Uri.file(realPath));
    const selection = line !== undefined ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection });
  }

  // ── HTML shell ────────────────────────────────────────────────────────────

  private buildHtml(ctx: vscode.ExtensionContext): string {
    const webview   = this.panel.webview;
    const nonce     = crypto.randomUUID().replace(/-/g, '');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dashboard-panel.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dashboard-panel.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource};
             script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Docs Agent Dashboard</title>
</head>
<body>
  <div id="app">
    <header id="dash-header">
      <span class="dash-title">Docs Agent — Dashboard</span>
      <button id="btn-refresh" class="btn-icon" title="Refresh all data">↺</button>
    </header>

    <div id="dash-grid">

      <section class="card" id="card-stats">
        <h2>Graph Stats</h2>
        <div id="stats-counts" class="stat-row"></div>
        <table id="stats-hotspots">
          <thead><tr><th>#</th><th>Symbol</th><th>Kind</th><th>Degree</th></tr></thead>
          <tbody></tbody>
        </table>
      </section>

      <section class="card" id="card-communities">
        <h2>Communities</h2>
        <ul id="community-list"></ul>
      </section>

      <section class="card" id="card-inspector">
        <h2>Symbol Inspector</h2>
        <div class="search-row">
          <input id="inspector-search" type="text" placeholder="Search symbol…" autocomplete="off" spellcheck="false" />
          <button id="btn-inspector-search" class="btn-primary">Search</button>
        </div>
        <ul id="inspector-results"></ul>
        <div id="inspector-detail"></div>
      </section>

      <section class="card" id="card-tokens">
        <h2>Token Usage</h2>
        <div id="token-totals"></div>
        <table id="token-table">
          <thead><tr><th>Time</th><th>Command</th><th>Provider</th><th>Model</th><th>Prompt</th><th>Completion</th></tr></thead>
          <tbody></tbody>
        </table>
      </section>

    </div>
  </div>
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
