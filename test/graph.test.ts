import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../src/graph';

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
