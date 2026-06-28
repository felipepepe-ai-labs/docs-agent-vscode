import * as path from 'path';
import type { GraphifyJson, GraphifyNode } from './graphify-runner';

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

  addNode(node: SymbolNode): void {
    this.nodes.set(node.symbol, node);
  }

  addCallEdge(edge: CallEdge): void {
    this.callEdges.push(edge);
  }

  addTableEdge(edge: TableEdge): void {
    this.tableEdges.push(edge);
  }

  addImplementsEdge(edge: ImplementsEdge): void {
    this.implementsEdges.push(edge);
  }

  addInjectsEdge(edge: InjectsEdge): void {
    this.injectsEdges.push(edge);
  }

  // Reverse-query: everything that references a class or method.
  // Accepts graphify node ids, human-readable labels, or dot-qualified names.
  queryImpact(symbolName: string): ImpactSummary {
    const nodeId = this._resolveId(symbolName);

    const isQualified   = nodeId.includes('.');
    const className     = isQualified ? nodeId.split('.')[0] : nodeId;
    const simpleMethod  = isQualified ? nodeId.split('.').slice(1).join('.') : nodeId;

    const callers = this.callEdges
      .filter(e => e.callee === simpleMethod || e.callee === nodeId)
      .map(e => ({ symbol: e.caller, file: e.callerFile, line: e.callerLine }));

    const tableRefs = this.tableEdges
      .filter(e => {
        if (isQualified) {
          const eMethod = e.symbol.includes('.') ? e.symbol.split('.').slice(1).join('.') : '';
          return e.symbol === nodeId || eMethod === simpleMethod;
        }
        return e.symbol === nodeId || e.symbol.startsWith(nodeId + '.');
      })
      .map(e => ({ table: e.table, operation: e.operation, symbol: e.symbol, file: e.file, line: e.line }));

    const implementors = this.implementsEdges
      .filter(e => e.contract === className || e.contract === nodeId)
      .map(e => e.implementor);

    const consumers = this.injectsEdges
      .filter(e => e.dependency === className || e.dependency === nodeId)
      .map(e => ({ symbol: e.consumer, fieldName: e.fieldName }));

    return { callers, tableRefs, implementors, consumers };
  }

  // Reverse-query: every symbol that references a given table.
  queryByTable(tableName: string): { symbol: string; file: string; line: number; operation: SqlOperation }[] {
    const lower = tableName.toLowerCase();
    return this.tableEdges
      .filter(e => e.table.toLowerCase() === lower)
      .map(e => ({ symbol: e.symbol, file: e.file, line: e.line, operation: e.operation }));
  }

  get nodeCount(): number { return this.nodes.size; }

  get edgeCount(): number {
    return this.callEdges.length + this.tableEdges.length +
      this.implementsEdges.length + this.injectsEdges.length;
  }

  // Resolve a user-typed name to an internal node id.
  // Tries: exact id → label match → dot-split class name match.
  private _resolveId(name: string): string {
    if (this.nodes.has(name)) return name;
    const lower = name.toLowerCase();
    for (const [id, node] of this.nodes) {
      if ((node.label ?? '').toLowerCase() === lower) return id;
    }
    return name;
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
