import * as path from 'path';
import type { GraphifyJson, GraphifyNode } from './graphify-runner';
import type { CbmManager } from './cbm-runner';

export type SymbolKind = 'class' | 'interface' | 'method' | 'constructor' | 'field';
export type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'unknown';

export interface SymbolNode {
  symbol: string;
  label?: string;   // human-readable display name (graphify label field)
  file: string;
  line: number;
  kind: SymbolKind;
}

export interface CallEdge {
  caller: string;
  callerFile: string;
  callerLine: number;
  callee: string;
}

export interface TableEdge {
  symbol: string;
  file: string;
  line: number;
  table: string;
  operation: SqlOperation;
}

export interface ImplementsEdge {
  implementor: string;
  contract: string;
}

export interface InjectsEdge {
  consumer: string;
  dependency: string;
  fieldName: string;
}

export interface ImpactSummary {
  callers: { symbol: string; file: string; line: number }[];
  tableRefs: { table: string; operation: SqlOperation; symbol: string; file: string; line: number }[];
  implementors: string[];
  consumers: { symbol: string; fieldName: string }[];
}

export class CodeGraph {
  readonly nodes       = new Map<string, SymbolNode>();
  readonly callEdges:      CallEdge[]       = [];
  readonly tableEdges:     TableEdge[]      = [];
  readonly implementsEdges: ImplementsEdge[] = [];
  readonly injectsEdges:   InjectsEdge[]    = [];

  // Lookup indexes, rebuilt lazily on the first query after any mutation.
  // Load pattern is bulk-insert-then-query, so one O(N+E) rebuild amortizes
  // every subsequent query down to O(result).
  private _dirty = true;
  private readonly _suffixIndex      = new Map<string, string[]>();       // last dot segment → symbols
  private readonly _labelIndex       = new Map<string, string>();         // lowercased label → first symbol
  private readonly _calleeIndex      = new Map<string, CallEdge[]>();
  private readonly _callerIndex      = new Map<string, CallEdge[]>();
  private readonly _contractIndex    = new Map<string, ImplementsEdge[]>();
  private readonly _dependencyIndex  = new Map<string, InjectsEdge[]>();
  private readonly _tableNameIndex   = new Map<string, TableEdge[]>();    // lowercased table name
  private readonly _tableSymbolIndex = new Map<string, TableEdge[]>();    // exact symbol
  private readonly _tableOwnerIndex  = new Map<string, TableEdge[]>();    // symbol's first dot segment
  private readonly _tableMethodIndex = new Map<string, TableEdge[]>();    // symbol after first dot

  addNode(node: SymbolNode): void {
    this.nodes.set(node.symbol, node);
    this._dirty = true;
  }

  addCallEdge(edge: CallEdge): void {
    this.callEdges.push(edge);
    this._dirty = true;
  }

  addTableEdge(edge: TableEdge): void {
    this.tableEdges.push(edge);
    this._dirty = true;
  }

  addImplementsEdge(edge: ImplementsEdge): void {
    this.implementsEdges.push(edge);
    this._dirty = true;
  }

  addInjectsEdge(edge: InjectsEdge): void {
    this.injectsEdges.push(edge);
    this._dirty = true;
  }

  // Absorb another graph's nodes and edges. Duplicate node symbols are
  // overwritten (last write wins); edges are appended without deduplication.
  merge(other: CodeGraph): void {
    for (const node of other.nodes.values()) this.addNode(node);
    this.callEdges.push(...other.callEdges);
    this.tableEdges.push(...other.tableEdges);
    this.implementsEdges.push(...other.implementsEdges);
    this.injectsEdges.push(...other.injectsEdges);
    this._dirty = true;
  }

  // Reverse-query: everything that references a class or method.
  // Accepts graphify node ids, human-readable labels, or dot-qualified names.
  queryImpact(symbolName: string): ImpactSummary {
    this._ensureIndexes();
    const nodeId = this._resolveId(symbolName);

    const isQualified   = nodeId.includes('.');
    const className     = isQualified ? nodeId.split('.')[0] : nodeId;
    const simpleMethod  = isQualified ? nodeId.split('.').slice(1).join('.') : nodeId;

    // Each edge lives in exactly one callee bucket, so no dedupe is needed.
    const callerEdges = simpleMethod === nodeId
      ? this._calleeIndex.get(nodeId) ?? []
      : [...(this._calleeIndex.get(simpleMethod) ?? []), ...(this._calleeIndex.get(nodeId) ?? [])];
    const callers = callerEdges
      .map(e => ({ symbol: e.caller, file: e.callerFile, line: e.callerLine }));

    // A qualified query can match one edge by symbol AND method suffix — dedupe via Set.
    const tableEdgeSet = new Set<TableEdge>(this._tableSymbolIndex.get(nodeId) ?? []);
    for (const e of (isQualified ? this._tableMethodIndex.get(simpleMethod) : this._tableOwnerIndex.get(nodeId)) ?? []) {
      tableEdgeSet.add(e);
    }
    const tableRefs = [...tableEdgeSet]
      .map(e => ({ table: e.table, operation: e.operation, symbol: e.symbol, file: e.file, line: e.line }));

    const implementorEdges = className === nodeId
      ? this._contractIndex.get(nodeId) ?? []
      : [...(this._contractIndex.get(className) ?? []), ...(this._contractIndex.get(nodeId) ?? [])];
    const implementors = implementorEdges.map(e => e.implementor);

    const consumerEdges = className === nodeId
      ? this._dependencyIndex.get(nodeId) ?? []
      : [...(this._dependencyIndex.get(className) ?? []), ...(this._dependencyIndex.get(nodeId) ?? [])];
    const consumers = consumerEdges.map(e => ({ symbol: e.consumer, fieldName: e.fieldName }));

    return { callers, tableRefs, implementors, consumers };
  }

  // Reverse-query: every symbol that references a given table.
  queryByTable(tableName: string): { symbol: string; file: string; line: number; operation: SqlOperation }[] {
    this._ensureIndexes();
    return (this._tableNameIndex.get(tableName.toLowerCase()) ?? [])
      .map(e => ({ symbol: e.symbol, file: e.file, line: e.line, operation: e.operation }));
  }

  // All node symbols whose last dot segment equals simpleName
  // (a dotless symbol is its own suffix).
  nodesBySuffix(simpleName: string): string[] {
    this._ensureIndexes();
    return this._suffixIndex.get(simpleName) ?? [];
  }

  // All call edges originating from the given caller symbol.
  callEdgesFrom(caller: string): CallEdge[] {
    this._ensureIndexes();
    return this._callerIndex.get(caller) ?? [];
  }

  get nodeCount(): number { return this.nodes.size; }

  get edgeCount(): number {
    return this.callEdges.length + this.tableEdges.length +
      this.implementsEdges.length + this.injectsEdges.length;
  }

  // Resolve a user-typed name to an internal node id.
  // Tries: exact id → label match (first node in insertion order).
  private _resolveId(name: string): string {
    if (this.nodes.has(name)) return name;
    return this._labelIndex.get(name.toLowerCase()) ?? name;
  }

  private _ensureIndexes(): void {
    if (!this._dirty) return;
    this._suffixIndex.clear();      this._labelIndex.clear();
    this._calleeIndex.clear();      this._callerIndex.clear();
    this._contractIndex.clear();    this._dependencyIndex.clear();
    this._tableNameIndex.clear();   this._tableSymbolIndex.clear();
    this._tableOwnerIndex.clear();  this._tableMethodIndex.clear();

    const push = <V>(m: Map<string, V[]>, k: string, v: V): void => {
      const bucket = m.get(k);
      if (bucket) bucket.push(v);
      else m.set(k, [v]);
    };

    for (const [symbol, node] of this.nodes) {
      push(this._suffixIndex, symbol.split('.').pop() ?? symbol, symbol);
      const label = (node.label ?? '').toLowerCase();
      if (label && !this._labelIndex.has(label)) this._labelIndex.set(label, symbol);
    }
    for (const e of this.callEdges) {
      push(this._calleeIndex, e.callee, e);
      push(this._callerIndex, e.caller, e);
    }
    for (const e of this.implementsEdges) push(this._contractIndex, e.contract, e);
    for (const e of this.injectsEdges)    push(this._dependencyIndex, e.dependency, e);
    for (const e of this.tableEdges) {
      push(this._tableNameIndex, e.table.toLowerCase(), e);
      push(this._tableSymbolIndex, e.symbol, e);
      const dot = e.symbol.indexOf('.');
      if (dot > 0) {
        push(this._tableOwnerIndex, e.symbol.slice(0, dot), e);
        push(this._tableMethodIndex, e.symbol.slice(dot + 1), e);
      }
    }
    this._dirty = false;
  }
}

// ── graphify graph.json → CodeGraph adapter ───────────────────────────────────

export function fromGraphifyJson(json: GraphifyJson, workspaceRoot: string): CodeGraph {
  const graph     = new CodeGraph();
  const nodeIndex = new Map<string, GraphifyNode>();

  for (const n of json.nodes) {
    nodeIndex.set(n.id, n);
    // Skip document / image / video nodes — they have no symbol structure.
    if (n.file_type && n.file_type !== 'code') continue;
    graph.addNode({
      symbol: n.id,
      label:  n.label,
      file:   n.source_file ? path.resolve(workspaceRoot, n.source_file) : workspaceRoot,
      line:   _parseLine(n.source_location),
      kind:   _inferKind(n),
    });
  }

  // NetworkX exports use "links"; some graphify builds use "edges".
  const links = json.links ?? json.edges ?? [];

  for (const link of links) {
    if (!graph.nodes.has(link.source) || !graph.nodes.has(link.target)) continue;
    const src = nodeIndex.get(link.source);

    switch (link.relation) {
      case 'calls':
      case 'references':
        graph.addCallEdge({
          caller:     link.source,
          callerFile: src?.source_file ? path.resolve(workspaceRoot, src.source_file) : workspaceRoot,
          callerLine: _parseLine(src?.source_location),
          callee:     link.target,
        });
        break;

      case 'implements':
        graph.addImplementsEdge({ implementor: link.source, contract: link.target });
        break;

      case 'uses':
      case 'injects': {
        const tgt = nodeIndex.get(link.target);
        graph.addInjectsEdge({
          consumer:   link.source,
          dependency: link.target,
          fieldName:  tgt?.label ?? link.target,
        });
        break;
      }

      // 'imports', 'depends_on', 'contains' — package/file-level; not useful at symbol granularity.
    }
  }

  return graph;
}

// ── codebase-memory-mcp → CodeGraph adapter ───────────────────────────────────

// Labels in codebase-memory-mcp that carry no symbol-level information.
const CBM_SKIP_LABELS = new Set(['File', 'Folder', 'Module', 'Variable', 'Import']);

export async function fromCbmQuery(cbm: CbmManager, workspaceRoot: string): Promise<CodeGraph> {
  const graph = new CodeGraph();

  // ── Nodes (paginated search_graph) ──────────────────────────────────────────
  const PAGE = 200;
  let offset = 0;
  while (true) {
    let page;
    try {
      page = await cbm.searchGraph({ limit: PAGE, offset });
    } catch { break; }

    for (const n of page.results) {
      if (!n.qualified_name || CBM_SKIP_LABELS.has(n.label)) continue;
      graph.addNode({
        symbol: n.qualified_name,
        label:  n.name ?? n.qualified_name.split('.').pop() ?? n.qualified_name,
        file:   n.file ?? workspaceRoot,
        line:   n.line ?? 1,
        kind:   _cbmLabelToKind(n.label),
      });
    }

    if (!page.has_more) break;
    offset += PAGE;
    if (offset >= 5000) break; // safety cap — panels render ≤120 nodes anyway
  }

  // ── CALLS edges ─────────────────────────────────────────────────────────────
  try {
    const { rows } = await cbm.queryGraph(
      'MATCH (a)-[:CALLS]->(b) WHERE a.file IS NOT NULL AND b.file IS NOT NULL ' +
      'RETURN a.qualified_name AS caller, a.file AS cf, a.line AS cl, b.qualified_name AS callee',
      5000,
    );
    for (const r of rows as { caller?: string; cf?: string; cl?: number; callee?: string }[]) {
      if (!r.caller || !r.callee) continue;
      graph.addCallEdge({
        caller:     r.caller,
        callerFile: r.cf ?? workspaceRoot,
        callerLine: r.cl ?? 1,
        callee:     r.callee.split('.').pop() ?? r.callee,
      });
    }
  } catch { /* Cypher subset may not support this query */ }

  // ── IMPLEMENTS edges ─────────────────────────────────────────────────────────
  try {
    const { rows } = await cbm.queryGraph(
      'MATCH (a)-[:IMPLEMENTS]->(b) ' +
      'RETURN a.qualified_name AS implementor, b.qualified_name AS contract',
      2000,
    );
    for (const r of rows as { implementor?: string; contract?: string }[]) {
      if (r.implementor && r.contract) {
        graph.addImplementsEdge({ implementor: r.implementor, contract: r.contract });
      }
    }
  } catch { /* skip */ }

  return graph;
}

function _cbmLabelToKind(label: string): SymbolKind {
  switch (label) {
    case 'Class':       return 'class';
    case 'Interface':   return 'interface';
    case 'Method':      return 'method';
    case 'Constructor': return 'constructor';
    case 'Field':       return 'field';
    default:            return 'method'; // Function, Route, etc.
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function _parseLine(loc?: string): number {
  if (!loc) return 1;
  const m = /L(\d+)/.exec(loc);
  return m ? parseInt(m[1], 10) : 1;
}

function _inferKind(n: GraphifyNode): SymbolKind {
  const label = n.label ?? '';
  if (label.startsWith('.') || /\(/.test(label)) return 'method';
  return 'class';
}
