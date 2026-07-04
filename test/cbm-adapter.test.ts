import { describe, expect, it } from 'vitest';
import { fromCbmQuery } from '../src/graph';
import type { CbmManager, CbmQueryResult } from '../src/cbm-runner';

function stubCbm(onQuery?: (cypher: string) => Promise<CbmQueryResult>): CbmManager {
  return {
    searchGraph: async () => ({
      results: [
        { qualified_name: 'OrderService.confirm', name: 'confirm', label: 'Method', file: '/ws/OrderService.java', line: 12 },
        { qualified_name: 'skipped.file', name: 'skipped', label: 'File' },
      ],
      total: 2,
      has_more: false,
    }),
    queryGraph: onQuery ?? (async () => ({ rows: [], total: 0 })),
  } as unknown as CbmManager;
}

describe('fromCbmQuery adapter', () => {
  it('adapts nodes and skips non-symbol labels', async () => {
    const g = await fromCbmQuery(stubCbm(), '/ws');
    expect(g.nodeCount).toBe(1);
    expect(g.nodes.get('OrderService.confirm')).toMatchObject({
      file: '/ws/OrderService.java',
      line: 12,
      kind: 'method',
    });
  });

  it('dispatches CALLS and IMPLEMENTS queries in parallel', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });

    const pending = fromCbmQuery(stubCbm(async (cypher) => {
      seen.push(cypher.includes(':CALLS') ? 'calls' : 'implements');
      await gate;
      return { rows: [], total: 0 };
    }), '/ws');

    await new Promise(r => setTimeout(r, 0));
    // Both queries must be in flight before either resolves.
    expect(seen).toEqual(['calls', 'implements']);

    release();
    await pending;
  });

  it('keeps IMPLEMENTS results when the CALLS query fails', async () => {
    const g = await fromCbmQuery(stubCbm(async (cypher) => {
      if (cypher.includes(':CALLS')) throw new Error('cypher subset unsupported');
      return { rows: [{ implementor: 'OrderServiceImpl', contract: 'OrderService' }], total: 1 };
    }), '/ws');

    expect(g.callEdges).toHaveLength(0);
    expect(g.implementsEdges).toEqual([{ implementor: 'OrderServiceImpl', contract: 'OrderService' }]);
  });
});
