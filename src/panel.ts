import * as vscode from 'vscode';
import { CodeGraph } from './graph';
import { buildGraph } from './indexer';
import { saveGraph } from './db';

type WebviewMessage =
  | { type: 'search';   query: string  }
  | { type: 'expand';   nodeId: string }
  | { type: 'overview'                 }
  | { type: 'reload'                   }
  | { type: 'openFile'; file: string; line?: number }
  | { type: 'query';    kind: string; target: string };

export class GraphPanel {
  private static instance: GraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private graph: CodeGraph;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(ctx: vscode.ExtensionContext, graph: CodeGraph): void {
    if (GraphPanel.instance) {
      GraphPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    GraphPanel.instance = new GraphPanel(ctx, graph);
  }

  private constructor(ctx: vscode.ExtensionContext, graph: CodeGraph) {
    this.graph = graph;

    this.panel = vscode.window.createWebviewPanel(
      'docsAgentGraph',
      'Docs Agent — Code Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
      }
    );

    this.panel.webview.html = this.buildHtml(ctx);

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.onMessage(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      GraphPanel.instance = undefined;
      this.dispose();
    }, null, this.disposables);

    // Send index stats so the toolbar shows node/edge counts immediately
    this.panel.webview.postMessage({
      type: 'stats',
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
    });

    // Auto-populate on open with an overview of the most-connected nodes
    this.sendOverviewGraph();
  }

  // ── Incoming messages from the webview ────────────────────────────────────

  private onMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'search':   this.sendSearchResults(msg.query);          break;
      case 'expand':   this.sendSubgraph(msg.nodeId);             break;
      case 'overview': this.sendOverviewGraph();                  break;
      case 'reload':   this.reloadGraph();                        break;
      case 'openFile': this.openFile(msg.file, msg.line).catch(err =>
        vscode.window.showErrorMessage(`Docs Agent: Cannot open file — ${(err as Error).message}`)
      ); break;
      case 'query':    this.sendQueryResult(msg.kind, msg.target); break;
    }
  }

  private async openFile(file: string, line?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(file);
    const selection = line !== undefined
      ? new vscode.Range(line - 1, 0, line - 1, 0)
      : undefined;
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection });
  }

  private reloadGraph(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return;

    this.panel.webview.postMessage({ type: 'reloading' });
    setImmediate(() => {
      try {
        const merged = new CodeGraph();
        for (const folder of folders) {
          const root = folder.uri.fsPath;
          const g = buildGraph(root);
          saveGraph(root, g);
          for (const node of g.nodes.values())   merged.addNode(node);
          for (const e of g.callEdges)           merged.addCallEdge(e);
          for (const e of g.tableEdges)          merged.addTableEdge(e);
          for (const e of g.implementsEdges)     merged.addImplementsEdge(e);
          for (const e of g.injectsEdges)        merged.addInjectsEdge(e);
        }
        this.graph = merged;
        this.panel.webview.postMessage({
          type:      'stats',
          nodeCount: this.graph.nodeCount,
          edgeCount: this.graph.edgeCount,
        });
        this.sendOverviewGraph();
      } catch (err) {
        vscode.window.showErrorMessage(`Docs Agent: Re-index failed — ${(err as Error).message}`);
      }
    });
  }

  private sendOverviewGraph(): void {
    const MAX_NODES = 120;
    const MAX_EDGES = 400;

    // callEdges store callee as a simple method name ("save"), not a full symbol
    // ("OrderRepository.save"). Build a suffix map for O(1) resolution.
    const suffixMap = new Map<string, string[]>();
    for (const sym of this.graph.nodes.keys()) {
      const simple = sym.includes('.') ? sym.split('.').pop()! : sym;
      if (!suffixMap.has(simple)) suffixMap.set(simple, []);
      suffixMap.get(simple)!.push(sym);
    }

    // Rank every node by degree — resolve call callees via suffix map
    const degree = new Map<string, number>();
    for (const n of this.graph.nodes.keys()) degree.set(n, 0);

    const bump = (id: string, n = 1) => {
      if (degree.has(id)) degree.set(id, degree.get(id)! + n);
    };

    for (const e of this.graph.callEdges) {
      bump(e.caller);
      for (const full of suffixMap.get(e.callee) ?? []) bump(full);
    }
    for (const e of this.graph.implementsEdges) {
      if (degree.has(e.implementor) && degree.has(e.contract)) {
        bump(e.implementor, 2); bump(e.contract, 2);
      }
    }
    for (const e of this.graph.injectsEdges) {
      if (degree.has(e.consumer) && degree.has(e.dependency)) {
        bump(e.consumer); bump(e.dependency, 2);
      }
    }
    for (const e of this.graph.tableEdges) {
      bump(e.symbol);
    }

    // Top N nodes by degree — skip isolated nodes (degree 0) entirely
    const topNodes = [...this.graph.nodes.values()]
      .sort((a, b) => degree.get(b.symbol)! - degree.get(a.symbol)!)
      .filter(n => degree.get(n.symbol)! > 0)
      .slice(0, MAX_NODES);

    const nodeSet = new Set(topNodes.map(n => n.symbol));

    // Add table nodes referenced by top nodes
    for (const e of this.graph.tableEdges) {
      if (nodeSet.has(e.symbol) && nodeSet.size < MAX_NODES + 20) {
        nodeSet.add(`table:${e.table}`);
      }
    }

    const nodeList = [...nodeSet].map(id => {
      if (id.startsWith('table:')) {
        return { id, label: id.slice(6), kind: 'table' };
      }
      const n = this.graph.nodes.get(id)!;
      return { id, label: n.symbol.split('.').pop() ?? n.symbol, kind: n.kind, file: n.file, line: n.line };
    });

    // Build edges between included nodes, resolving call callees via suffix map
    const edgeList: { source: string; target: string; label: string }[] = [];

    for (const e of this.graph.callEdges) {
      if (edgeList.length >= MAX_EDGES) break;
      if (!nodeSet.has(e.caller)) continue;
      for (const full of suffixMap.get(e.callee) ?? []) {
        if (nodeSet.has(full) && full !== e.caller) {
          edgeList.push({ source: e.caller, target: full, label: 'calls' });
        }
      }
    }
    for (const e of this.graph.implementsEdges) {
      if (edgeList.length >= MAX_EDGES) break;
      if (nodeSet.has(e.implementor) && nodeSet.has(e.contract)) {
        edgeList.push({ source: e.implementor, target: e.contract, label: 'implements' });
      }
    }
    for (const e of this.graph.injectsEdges) {
      if (edgeList.length >= MAX_EDGES) break;
      if (nodeSet.has(e.consumer) && nodeSet.has(e.dependency)) {
        edgeList.push({ source: e.consumer, target: e.dependency, label: 'injects' });
      }
    }
    for (const e of this.graph.tableEdges) {
      const tid = `table:${e.table}`;
      if (edgeList.length >= MAX_EDGES) break;
      if (nodeSet.has(e.symbol) && nodeSet.has(tid)) {
        edgeList.push({ source: e.symbol, target: tid, label: e.operation });
      }
    }

    this.panel.webview.postMessage({
      type:     'subgraph',
      centerId: '',
      nodes:    nodeList,
      edges:    dedupeEdges(edgeList),
    });
  }

  private sendSearchResults(query: string): void {
    const q = query.toLowerCase();
    const results = [...this.graph.nodes.values()]
      .filter(n => n.symbol.toLowerCase().includes(q))
      .slice(0, 20)
      .map(n => ({
        id:    n.symbol,
        label: n.symbol.split('.').pop() ?? n.symbol,
        kind:  n.kind,
        file:  n.file,
        line:  n.line,
      }));

    this.panel.webview.postMessage({ type: 'searchResults', results });
  }

  private sendSubgraph(nodeId: string): void {
    const impact = this.graph.queryImpact(nodeId);
    const center = this.graph.nodes.get(nodeId);

    const nodeSet  = new Set<string>([nodeId]);
    const edgeList: { source: string; target: string; label: string }[] = [];

    for (const c of impact.callers.slice(0, 12)) {
      nodeSet.add(c.symbol);
      edgeList.push({ source: c.symbol, target: nodeId, label: 'calls' });
    }

    for (const impl of impact.implementors.slice(0, 8)) {
      nodeSet.add(impl);
      edgeList.push({ source: impl, target: nodeId, label: 'implements' });
    }

    for (const cons of impact.consumers.slice(0, 8)) {
      nodeSet.add(cons.symbol);
      edgeList.push({ source: cons.symbol, target: nodeId, label: 'injects' });
    }

    for (const t of impact.tableRefs.slice(0, 8)) {
      const tid = `table:${t.table}`;
      nodeSet.add(tid);
      edgeList.push({ source: nodeId, target: tid, label: t.operation });
    }

    // Callees — match simple method name against known nodes
    const callees = this.graph.callEdges
      .filter(e => e.caller === nodeId)
      .slice(0, 10);

    for (const c of callees) {
      const matches = [...this.graph.nodes.values()]
        .filter(n => n.symbol.endsWith('.' + c.callee) || n.symbol === c.callee)
        .slice(0, 3);
      for (const m of matches) {
        nodeSet.add(m.symbol);
        edgeList.push({ source: nodeId, target: m.symbol, label: 'calls' });
      }
    }

    const nodeList = [...nodeSet].map(id => {
      if (id.startsWith('table:')) {
        return { id, label: id.slice(6), kind: 'table' };
      }
      const n = this.graph.nodes.get(id);
      return n
        ? { id, label: n.symbol.split('.').pop() ?? n.symbol, kind: n.kind, file: n.file, line: n.line }
        : { id, label: id.split('.').pop() ?? id, kind: 'unknown' };
    });

    this.panel.webview.postMessage({
      type:     'subgraph',
      centerId: nodeId,
      nodes:    nodeList,
      edges:    dedupeEdges(edgeList),
    });
  }

  private sendQueryResult(kind: string, target: string): void {
    let question = '';
    let lines: string[] = [];
    const nodeSet  = new Set<string>();
    const edgeList: { source: string; target: string; label: string }[] = [];

    switch (kind) {
      case 'tables-for-symbol': {
        const { tableRefs } = this.graph.queryImpact(target);
        question = `Tables touched by "${target}"`;
        if (tableRefs.length === 0) {
          lines = ['No table references found.'];
        } else {
          nodeSet.add(target);
          for (const t of tableRefs) {
            const tid = `table:${t.table}`;
            nodeSet.add(tid);
            edgeList.push({ source: target, target: tid, label: t.operation });
            lines.push(`${t.table} — ${t.operation}  (${t.file.split('/').pop()}:${t.line})`);
          }
        }
        break;
      }
      case 'callers-of': {
        const { callers } = this.graph.queryImpact(target);
        question = `Callers of "${target}"`;
        if (callers.length === 0) {
          lines = ['No callers found.'];
        } else {
          nodeSet.add(target);
          for (const c of callers) {
            nodeSet.add(c.symbol);
            edgeList.push({ source: c.symbol, target, label: 'calls' });
            lines.push(`${c.symbol}  (${c.file.split('/').pop()}:${c.line})`);
          }
        }
        break;
      }
      case 'consumers-of': {
        const { consumers } = this.graph.queryImpact(target);
        question = `Injectors of "${target}"`;
        if (consumers.length === 0) {
          lines = ['No injectors found.'];
        } else {
          nodeSet.add(target);
          for (const c of consumers) {
            nodeSet.add(c.symbol);
            edgeList.push({ source: c.symbol, target, label: 'injects' });
            lines.push(`${c.symbol}  via ${c.fieldName}`);
          }
        }
        break;
      }
      case 'methods-for-table': {
        const refs = this.graph.queryByTable(target);
        question = `Methods touching table "${target}"`;
        if (refs.length === 0) {
          lines = ['No methods found referencing this table.'];
        } else {
          const tid = `table:${target}`;
          nodeSet.add(tid);
          for (const r of refs) {
            nodeSet.add(r.symbol);
            edgeList.push({ source: r.symbol, target: tid, label: r.operation });
            lines.push(`${r.symbol} — ${r.operation}  (${r.file.split('/').pop()}:${r.line})`);
          }
        }
        break;
      }
    }

    this.panel.webview.postMessage({ type: 'queryAnswer', question, lines });

    if (nodeSet.size > 1) {
      const centerId = kind === 'methods-for-table' ? `table:${target}` : target;
      const nodeList = [...nodeSet].map(id => {
        if (id.startsWith('table:')) {
          return { id, label: id.slice(6), kind: 'table' };
        }
        const n = this.graph.nodes.get(id);
        return n
          ? { id, label: n.symbol.split('.').pop() ?? n.symbol, kind: n.kind, file: n.file, line: n.line }
          : { id, label: id.split('.').pop() ?? id, kind: 'unknown' };
      });
      this.panel.webview.postMessage({
        type: 'subgraph',
        centerId,
        nodes: nodeList,
        edges: dedupeEdges(edgeList),
      });
    }
  }

  // ── HTML shell ────────────────────────────────────────────────────────────

  private buildHtml(ctx: vscode.ExtensionContext): string {
    const webview   = this.panel.webview;
    const nonce     = randomNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(ctx.extensionUri, 'media', 'graph-panel.js')
    );
    const styleUri  = webview.asWebviewUri(
      vscode.Uri.joinPath(ctx.extensionUri, 'media', 'graph-panel.css')
    );

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
  <title>Code Graph</title>
</head>
<body>
  <div id="toolbar">
    <input id="search" type="text"
      placeholder="Search symbol… class, method, or table"
      autocomplete="off" spellcheck="false" />
    <span id="stats"></span>
    <button class="toolbar-btn" id="btn-zoom-in"  title="Zoom in">+</button>
    <button class="toolbar-btn" id="btn-zoom-out" title="Zoom out">−</button>
    <button class="toolbar-btn" id="btn-overview" title="Return to overview graph">Overview</button>
    <button class="toolbar-btn" id="btn-clear"    title="Clear the graph canvas">Clear</button>
    <button class="toolbar-btn" id="btn-reload"   title="Re-scan source files and rebuild the graph">↺ Re-index</button>
  </div>
  <div id="query-bar">
    <select id="query-kind">
      <option value="tables-for-symbol">Tables touched by…</option>
      <option value="callers-of">Callers of…</option>
      <option value="consumers-of">Injectors of…</option>
      <option value="methods-for-table">Methods touching table…</option>
    </select>
    <input id="query-target" type="text"
      placeholder="symbol or table name"
      autocomplete="off" spellcheck="false" />
    <button class="toolbar-btn" id="btn-query">Ask ↵</button>
    <button class="toolbar-btn" id="btn-query-clear" title="Clear answer">✕</button>
  </div>
  <div id="query-answer"></div>
  <div id="results"></div>
  <div id="graph"></div>
  <div id="detail"></div>
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomNonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function dedupeEdges(edges: { source: string; target: string; label: string }[]) {
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.source}→${e.target}:${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
