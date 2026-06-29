import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CbmManager } from './cbm-runner';
import { CodeGraph, fromGraphifyJson } from './graph';
import { loadGraphJson, runGraphify } from './graphify-runner';

type WebviewMessage =
  | { type: 'search';   query: string  }
  | { type: 'expand';   nodeId: string }
  | { type: 'overview'                 }
  | { type: 'reload'                   }
  | { type: 'openFile'; file: string; line?: number }
  | { type: 'query';    kind: string; target: string };

export class GraphPanel {
  private static instance: GraphPanel | undefined;

  private readonly panel:         vscode.WebviewPanel;
  private graph:                  CodeGraph;
  private readonly cbm?:          CbmManager;
  private readonly workspaceRoot: string;
  // name → {kind, file (relative)} for expand lookups when using CBM layout
  private cbmNodeData = new Map<string, { kind: string; file: string }>();
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(ctx: vscode.ExtensionContext, graph: CodeGraph, cbm?: CbmManager): void {
    if (GraphPanel.instance) {
      GraphPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    GraphPanel.instance = new GraphPanel(ctx, graph, cbm);
  }

  private constructor(ctx: vscode.ExtensionContext, graph: CodeGraph, cbm?: CbmManager) {
    this.graph         = graph;
    this.cbm           = cbm;
    this.workspaceRoot = cbm?.repoPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

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
    try {
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
    } catch (err) {
      vscode.window.showErrorMessage(`Docs Agent: Graph error — ${(err as Error).message}`);
    }
  }

  private async openFile(file: string, line?: number): Promise<void> {
    let realPath: string;
    try {
      realPath = fs.realpathSync(file);
    } catch {
      throw new Error(`Cannot resolve path: ${file}`);
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const inWorkspace = folders.some(f => {
      const root = f.uri.fsPath;
      return realPath === root || realPath.startsWith(root + path.sep);
    });
    if (!inWorkspace) {
      throw new Error(`File is outside the workspace: ${file}`);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(realPath));
    const selection = line !== undefined
      ? new vscode.Range(line - 1, 0, line - 1, 0)
      : undefined;
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection });
  }

  private reloadGraph(): void {
    if (this.cbm) {
      this.panel.webview.postMessage({ type: 'reloading' });
      void this.cbm.reindex('moderate').then(() => this.sendOverviewGraph()).catch(err =>
        vscode.window.showErrorMessage(`Docs Agent: CBM re-index failed — ${(err as Error).message}`)
      );
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return;

    this.panel.webview.postMessage({ type: 'reloading' });
    void (async () => {
      try {
        const merged = new CodeGraph();
        for (const folder of folders) {
          const root = folder.uri.fsPath;
          await runGraphify(root, true);
          const json = loadGraphJson(root);
          if (!json) continue;
          const g = fromGraphifyJson(json, root);
          for (const node of g.nodes.values())    merged.addNode(node);
          for (const e of g.callEdges)            merged.addCallEdge(e);
          for (const e of g.tableEdges)           merged.addTableEdge(e);
          for (const e of g.implementsEdges)      merged.addImplementsEdge(e);
          for (const e of g.injectsEdges)         merged.addInjectsEdge(e);
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
    })();
  }

  private sendOverviewGraph(): void {
    if (this.cbm) {
      void this.sendOverviewGraphCbm();
      return;
    }
    this.sendOverviewGraphLocal();
  }

  private async sendOverviewGraphCbm(): Promise<void> {
    try {
      const result = await this.cbm!.fetchLayout(300);

      // Normalize all coordinates into ±900 world units
      let maxCoord = 1;
      for (const n of result.nodes) {
        if (isFinite(n.x)) maxCoord = Math.max(maxCoord, Math.abs(n.x));
        if (isFinite(n.y)) maxCoord = Math.max(maxCoord, Math.abs(n.y));
        if (isFinite(n.z)) maxCoord = Math.max(maxCoord, Math.abs(n.z));
      }
      const scale = 900 / maxCoord;

      // Cache node data (name → meta) for expand lookups
      this.cbmNodeData.clear();
      const idToName = new Map<number, string>();
      for (const n of result.nodes) {
        idToName.set(n.id, n.name);
        this.cbmNodeData.set(n.name, { kind: _cbmLabelToKind(n.label), file: n.file_path ?? '' });
      }

      const nameSet = new Set<string>();
      const nodes = result.nodes.map(n => {
        nameSet.add(n.name);
        return {
          id:    n.name,
          label: n.name,
          kind:  _cbmLabelToKind(n.label),
          file:  n.file_path ? path.join(this.workspaceRoot, n.file_path) : undefined,
          x:     isFinite(n.x) ? n.x * scale : 0,
          y:     isFinite(n.y) ? n.y * scale : 0,
          z:     isFinite(n.z) ? n.z * scale : 0,
        };
      });

      const edges = result.edges.flatMap(e => {
        const src = idToName.get(e.source);
        const tgt = idToName.get(e.target);
        if (!src || !tgt || !nameSet.has(src) || !nameSet.has(tgt)) return [];
        return [{ source: src, target: tgt, label: e.type.toLowerCase() }];
      });

      this.panel.webview.postMessage({
        type:      'stats',
        nodeCount: result.total_nodes,
        edgeCount: result.edges.length,
      });
      this.panel.webview.postMessage({
        type:        'subgraph',
        centerId:    '',
        nodes,
        edges:       dedupeEdges(edges),
        precomputed: true,
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Docs Agent: CBM layout failed — ${(err as Error).message}`);
    }
  }

  private sendOverviewGraphLocal(): void {
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
      return { id, label: n.label ?? n.symbol.split('.').pop() ?? n.symbol, kind: n.kind, file: n.file, line: n.line };
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
    if (this.cbm) {
      void this.sendSearchResultsCbm(query);
      return;
    }
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

  private async sendSearchResultsCbm(query: string): Promise<void> {
    try {
      const page = await this.cbm!.searchGraph({ query, limit: 20 });
      const results = page.results.map(n => ({
        id:    n.name ?? n.qualified_name,
        label: n.name ?? (n.qualified_name.split('.').pop() ?? n.qualified_name),
        kind:  _cbmLabelToKind(n.label),
        file:  n.file,
        line:  n.line,
      }));
      this.panel.webview.postMessage({ type: 'searchResults', results });
    } catch (err) {
      console.warn('[Docs Agent] CBM search failed:', err);
    }
  }

  private sendSubgraph(nodeId: string): void {
    if (this.cbm) {
      void this.sendSubgraphCbm(nodeId);
      return;
    }
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

  private async sendSubgraphCbm(nodeId: string): Promise<void> {
    // nodeId is the node's display name (set during overview from CBM layout)
    const safe     = nodeId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const nodeSet  = new Set<string>([nodeId]);
    const edgeList: { source: string; target: string; label: string }[] = [];
    const nodeData = new Map<string, { kind: string; file?: string; line?: number }>();

    const cached = this.cbmNodeData.get(nodeId);
    if (cached) {
      nodeData.set(nodeId, {
        kind: cached.kind,
        file: cached.file ? path.join(this.workspaceRoot, cached.file) : undefined,
      });
    }

    const addNeighbor = (
      r: { name?: string; label?: string; file?: string; line?: number },
      src: string,
      tgt: string,
    ) => {
      if (!r.name) return;
      nodeSet.add(r.name);
      edgeList.push({ source: src, target: tgt, label: 'calls' });
      if (!nodeData.has(r.name)) {
        nodeData.set(r.name, {
          kind: _cbmLabelToKind(r.label ?? ''),
          file: r.file,
          line: r.line,
        });
      }
    };

    try {
      const { rows: outRows } = await this.cbm!.queryGraph(
        `MATCH (n {name: '${safe}'})-[:CALLS]->(m) WHERE m.file IS NOT NULL ` +
        `RETURN m.name AS name, m.label AS label, m.file AS file, m.line AS line LIMIT 15`,
      );
      for (const r of outRows as { name?: string; label?: string; file?: string; line?: number }[]) {
        addNeighbor(r, nodeId, r.name!);
      }

      const { rows: inRows } = await this.cbm!.queryGraph(
        `MATCH (m)-[:CALLS]->(n {name: '${safe}'}) WHERE m.file IS NOT NULL ` +
        `RETURN m.name AS name, m.label AS label, m.file AS file, m.line AS line LIMIT 15`,
      );
      for (const r of inRows as { name?: string; label?: string; file?: string; line?: number }[]) {
        addNeighbor(r, r.name!, nodeId);
      }
    } catch (err) {
      console.warn('[Docs Agent] CBM expand query failed:', err);
    }

    const nodeList = [...nodeSet].map(id => {
      const d = nodeData.get(id);
      return { id, label: id, kind: d?.kind ?? 'method', file: d?.file, line: d?.line };
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

function _cbmLabelToKind(label: string): string {
  switch (label) {
    case 'Class':       return 'class';
    case 'Interface':   return 'interface';
    case 'Method':      return 'method';
    case 'Constructor': return 'constructor';
    case 'Field':       return 'field';
    default:            return 'method';
  }
}

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
