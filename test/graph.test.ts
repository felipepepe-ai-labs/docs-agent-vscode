import { describe, expect, it } from 'vitest';
import { CodeGraph, fromGraphifyJson } from '../src/graph';
import type { GraphifyJson } from '../src/graphify-runner';

function sampleGraph(): CodeGraph {
  const g = new CodeGraph();
  g.addNode({ symbol: 'OrderService', label: 'OrderService', file: '/ws/OrderService.java', line: 5, kind: 'interface' });
  g.addNode({ symbol: 'OrderServiceImpl', label: 'OrderServiceImpl', file: '/ws/OrderServiceImpl.java', line: 8, kind: 'class' });
  g.addNode({ symbol: 'OrderController.create', label: '.create()', file: '/ws/OrderController.java', line: 21, kind: 'method' });
  g.addCallEdge({ caller: 'OrderController.create', callerFile: '/ws/OrderController.java', callerLine: 22, callee: 'confirm' });
  g.addImplementsEdge({ implementor: 'OrderServiceImpl', contract: 'OrderService' });
  g.addInjectsEdge({ consumer: 'OrderController', dependency: 'OrderService', fieldName: 'orderService' });
  g.addTableEdge({ symbol: 'OrderServiceImpl.confirm', file: '/ws/OrderServiceImpl.java', line: 30, table: 'ORDERS', operation: 'UPDATE' });
  return g;
}

describe('CodeGraph.queryImpact', () => {
  it('finds callers by simple method name', () => {
    const impact = sampleGraph().queryImpact('OrderService.confirm');
    expect(impact.callers).toEqual([
      { symbol: 'OrderController.create', file: '/ws/OrderController.java', line: 22 },
    ]);
  });

  it('finds implementors and consumers by class name', () => {
    const impact = sampleGraph().queryImpact('OrderService');
    expect(impact.implementors).toEqual(['OrderServiceImpl']);
    expect(impact.consumers).toEqual([{ symbol: 'OrderController', fieldName: 'orderService' }]);
  });

  it('finds table refs for qualified method names', () => {
    const impact = sampleGraph().queryImpact('OrderServiceImpl.confirm');
    expect(impact.tableRefs).toHaveLength(1);
    expect(impact.tableRefs[0].table).toBe('ORDERS');
  });

  it('resolves human-readable labels case-insensitively', () => {
    const impact = sampleGraph().queryImpact('orderserviceimpl');
    expect(impact.implementors).toEqual([]);
    // resolved to the OrderServiceImpl node id — table refs match via prefix
    const byPrefix = sampleGraph().queryImpact('OrderServiceImpl');
    expect(byPrefix.tableRefs).toHaveLength(1);
  });

  it('queries by table name case-insensitively', () => {
    const rows = sampleGraph().queryByTable('orders');
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('UPDATE');
  });

  it('resolves node labels case-insensitively to node ids', () => {
    const impact = sampleGraph().queryImpact('orderservice');
    expect(impact.implementors).toEqual(['OrderServiceImpl']);
    expect(impact.consumers).toEqual([{ symbol: 'OrderController', fieldName: 'orderService' }]);
  });
});

describe('CodeGraph index API', () => {
  it('resolves symbols by simple-name suffix', () => {
    const g = sampleGraph();
    expect(g.nodesBySuffix('create')).toEqual(['OrderController.create']);
    expect(g.nodesBySuffix('OrderService')).toEqual(['OrderService']);
    expect(g.nodesBySuffix('nope')).toEqual([]);
  });

  it('returns call edges originating from a caller', () => {
    const g = sampleGraph();
    const out = g.callEdgesFrom('OrderController.create');
    expect(out).toHaveLength(1);
    expect(out[0].callee).toBe('confirm');
    expect(g.callEdgesFrom('ghost')).toEqual([]);
  });

  it('keeps indexes consistent after merge', () => {
    const a = sampleGraph();
    // Query once so indexes are built, then mutate via merge.
    expect(a.nodesBySuffix('create')).toEqual(['OrderController.create']);

    const b = new CodeGraph();
    b.addNode({ symbol: 'PaymentService.pay', label: '.pay()', file: '/ws2/PaymentService.java', line: 9, kind: 'method' });
    b.addCallEdge({ caller: 'PaymentService.pay', callerFile: '/ws2/PaymentService.java', callerLine: 10, callee: 'confirm' });
    a.merge(b);

    expect(a.nodesBySuffix('pay')).toEqual(['PaymentService.pay']);
    expect(a.callEdgesFrom('PaymentService.pay')).toHaveLength(1);
    expect(a.queryImpact('OrderService.confirm').callers).toHaveLength(2);
  });

  it('refreshes label lookups after a node overwrite', () => {
    const g = sampleGraph();
    expect(g.queryImpact('orderservice').implementors).toEqual(['OrderServiceImpl']);

    g.addNode({ symbol: 'OrderService', label: 'BillingContract', file: '/ws/OrderService.java', line: 5, kind: 'interface' });

    expect(g.queryImpact('billingcontract').implementors).toEqual(['OrderServiceImpl']);
    expect(g.queryImpact('orderservice').implementors).toEqual([]);
  });
});

describe('CodeGraph.merge', () => {
  it('merges nodes and all edge types from another graph', () => {
    const a = sampleGraph();
    const b = new CodeGraph();
    b.addNode({ symbol: 'PaymentService', label: 'PaymentService', file: '/ws2/PaymentService.java', line: 3, kind: 'class' });
    b.addCallEdge({ caller: 'PaymentService.pay', callerFile: '/ws2/PaymentService.java', callerLine: 9, callee: 'charge' });
    b.addTableEdge({ symbol: 'PaymentService.pay', file: '/ws2/PaymentService.java', line: 12, table: 'PAYMENTS', operation: 'INSERT' });
    b.addImplementsEdge({ implementor: 'PaymentServiceImpl', contract: 'PaymentService' });
    b.addInjectsEdge({ consumer: 'CheckoutController', dependency: 'PaymentService', fieldName: 'payments' });

    a.merge(b);

    expect(a.nodes.has('PaymentService')).toBe(true);
    expect(a.nodeCount).toBe(4);
    expect(a.callEdges).toHaveLength(2);
    expect(a.tableEdges).toHaveLength(2);
    expect(a.implementsEdges).toHaveLength(2);
    expect(a.injectsEdges).toHaveLength(2);
  });

  it('last write wins for duplicate node symbols', () => {
    const a = sampleGraph();
    const b = new CodeGraph();
    b.addNode({ symbol: 'OrderService', label: 'OrderService', file: '/other/OrderService.java', line: 99, kind: 'interface' });

    a.merge(b);

    expect(a.nodeCount).toBe(3);
    expect(a.nodes.get('OrderService')!.line).toBe(99);
  });
});

describe('fromGraphifyJson adapter', () => {
  const json: GraphifyJson = {
    nodes: [
      { id: 'OrderService', label: 'OrderService', source_file: 'src/OrderService.java', source_location: 'L5' },
      { id: 'OrderServiceImpl', label: 'OrderServiceImpl', source_file: 'src/OrderServiceImpl.java', source_location: 'L8' },
      { id: 'OrderServiceImpl.confirm', label: '.confirm()', source_file: 'src/OrderServiceImpl.java', source_location: 'L30' },
      { id: 'diagram.png', label: 'diagram', file_type: 'image' },
    ],
    links: [
      { source: 'OrderServiceImpl.confirm', target: 'OrderService', relation: 'calls' },
      { source: 'OrderServiceImpl', target: 'OrderService', relation: 'implements' },
      { source: 'OrderServiceImpl', target: 'OrderService', relation: 'injects' },
      { source: 'OrderServiceImpl', target: 'OrderService', relation: 'contains' },
      { source: 'ghost', target: 'OrderService', relation: 'calls' },
    ],
  };

  it('adapts nodes, skipping non-code file types', () => {
    const g = fromGraphifyJson(json, '/ws');
    expect(g.nodeCount).toBe(3);
    expect(g.nodes.has('diagram.png')).toBe(false);
    expect(g.nodes.get('OrderService')).toMatchObject({ file: '/ws/src/OrderService.java', line: 5 });
  });

  it('infers method kind from label shape', () => {
    const g = fromGraphifyJson(json, '/ws');
    expect(g.nodes.get('OrderServiceImpl.confirm')!.kind).toBe('method');
    expect(g.nodes.get('OrderService')!.kind).toBe('class');
  });

  it('maps relations to typed edges and drops package-level ones', () => {
    const g = fromGraphifyJson(json, '/ws');
    expect(g.callEdges).toHaveLength(1);
    expect(g.implementsEdges).toHaveLength(1);
    expect(g.injectsEdges).toHaveLength(1);
  });

  it('drops edges whose endpoints are not in the node set', () => {
    const g = fromGraphifyJson(json, '/ws');
    expect(g.callEdges.some(e => e.caller === 'ghost')).toBe(false);
  });

  it('reads "edges" key when "links" is absent', () => {
    const alt: GraphifyJson = { nodes: json.nodes, edges: json.links };
    const g = fromGraphifyJson(alt, '/ws');
    expect(g.callEdges).toHaveLength(1);
  });
});
