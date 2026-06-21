export type SymbolKind = 'class' | 'interface' | 'method' | 'constructor' | 'field';
export type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'unknown';

export interface SymbolNode {
  symbol: string;
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
  readonly nodes = new Map<string, SymbolNode>();
  readonly callEdges: CallEdge[] = [];
  readonly tableEdges: TableEdge[] = [];
  readonly implementsEdges: ImplementsEdge[] = [];
  readonly injectsEdges: InjectsEdge[] = [];

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
  // symbolName can be "ClassName", "ClassName.methodName", or just "methodName".
  queryImpact(symbolName: string): ImpactSummary {
    const isQualified = symbolName.includes('.');
    const className = isQualified ? symbolName.split('.')[0] : symbolName;
    const simpleMethod = isQualified ? symbolName.split('.').slice(1).join('.') : symbolName;

    const callers = this.callEdges
      .filter(e => e.callee === simpleMethod)
      .map(e => ({ symbol: e.caller, file: e.callerFile, line: e.callerLine }));

    const tableRefs = this.tableEdges
      .filter(e => {
        if (isQualified) {
          const eMethod = e.symbol.includes('.') ? e.symbol.split('.').slice(1).join('.') : '';
          return e.symbol === symbolName || eMethod === simpleMethod;
        }
        return e.symbol === symbolName || e.symbol.startsWith(symbolName + '.');
      })
      .map(e => ({ table: e.table, operation: e.operation, symbol: e.symbol, file: e.file, line: e.line }));

    const implementors = this.implementsEdges
      .filter(e => e.contract === className)
      .map(e => e.implementor);

    const consumers = this.injectsEdges
      .filter(e => e.dependency === className)
      .map(e => ({ symbol: e.consumer, fieldName: e.fieldName }));

    return { callers, tableRefs, implementors, consumers };
  }

  get nodeCount(): number { return this.nodes.size; }

  get edgeCount(): number {
    return this.callEdges.length + this.tableEdges.length +
      this.implementsEdges.length + this.injectsEdges.length;
  }
}
