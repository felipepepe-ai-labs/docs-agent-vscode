import { describe, expect, it } from 'vitest';
import { renderMarkdown, validateAndParse, verifyCitationsAgainstGraph } from '../src/schema';
import type { CbmManager, CbmQueryResult } from '../src/cbm-runner';

const CTX = new Set(['src/main/java/com/example/OrderService.java']);

function stubCbm(onQuery?: (cypher: string) => Promise<CbmQueryResult>): CbmManager {
  return {
    repoPath:   '/ws',
    queryGraph: onQuery ?? (async () => ({ rows: [], total: 0 })),
  } as unknown as CbmManager;
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'OrderService.confirm',
    type: 'method',
    file: 'src/main/java/com/example/OrderService.java',
    line: 42,
    summary: 'Confirms an order.',
    ...overrides,
  };
}

describe('validateAndParse — anti-hallucination contract', () => {
  it('accepts a fully cited entry', () => {
    const result = validateAndParse(JSON.stringify([entry()]), CTX);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.valid[0].symbol).toBe('OrderService.confirm');
  });

  it('rejects the whole response when it is not JSON', () => {
    const result = validateAndParse('The method confirm() does...', CTX);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('Response is not valid JSON');
  });

  it('rejects a JSON object root — only arrays are valid', () => {
    const result = validateAndParse(JSON.stringify(entry()), CTX);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('Root value is not an array');
  });

  it('strips accidental markdown fences before parsing', () => {
    const fenced = '```json\n' + JSON.stringify([entry()]) + '\n```';
    const result = validateAndParse(fenced, CTX);
    expect(result.valid).toHaveLength(1);
  });

  it('rejects entries whose file is not a // FILE: header from the context', () => {
    const result = validateAndParse(
      JSON.stringify([entry({ file: 'src/main/java/com/example/Invented.java' })]),
      CTX
    );
    expect(result.valid).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('does not match any // FILE: header');
  });

  it('rejects entries without a line citation', () => {
    const noLine = entry();
    delete noLine.line;
    const result = validateAndParse(JSON.stringify([noLine]), CTX);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('"line"');
  });

  it('rejects non-positive or non-numeric line values', () => {
    for (const line of [0, -3, '42', null]) {
      const result = validateAndParse(JSON.stringify([entry({ line })]), CTX);
      expect(result.valid).toHaveLength(0);
    }
  });

  it('rejects invalid type values but keeps valid siblings', () => {
    const result = validateAndParse(
      JSON.stringify([entry(), entry({ type: 'module' })]),
      CTX
    );
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('Invalid "type"');
  });

  it('rejects non-object entries', () => {
    const result = validateAndParse(JSON.stringify(['just a string', null, 7]), CTX);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
  });
});

describe('verifyCitationsAgainstGraph — second-layer graph check', () => {
  // Entry "file" values are absolute (as they are in production, built from
  // ctx.primary.filePath); CBM's file_path is relative to repoPath ('/ws' here).
  const ABS_FILE = '/ws/src/main/java/com/example/OrderService.java';
  const REL_FILE = 'src/main/java/com/example/OrderService.java';
  const ABS_CTX = new Set([ABS_FILE]);

  it('rejects an entry whose cited line has no nearby node in the CBM index', async () => {
    const base = validateAndParse(JSON.stringify([entry({ file: ABS_FILE, line: 42 })]), ABS_CTX);
    const cbm = stubCbm(async () => ({
      rows: [{ file: REL_FILE, line: 900 }],
      total: 1,
    }));
    const result = await verifyCitationsAgainstGraph(base, cbm);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('No indexed symbol near');
  });

  it('keeps an entry within the line tolerance of an indexed node', async () => {
    const base = validateAndParse(JSON.stringify([entry({ file: ABS_FILE, line: 42 })]), ABS_CTX);
    const cbm = stubCbm(async () => ({
      rows: [{ file: REL_FILE, line: 43 }],
      total: 1,
    }));
    const result = await verifyCitationsAgainstGraph(base, cbm);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('does not punish entries in a file the graph has zero coverage for', async () => {
    const base = validateAndParse(JSON.stringify([entry({ file: ABS_FILE, line: 42 })]), ABS_CTX);
    const cbm = stubCbm(async () => ({ rows: [], total: 0 }));
    const result = await verifyCitationsAgainstGraph(base, cbm);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('degrades to the base result when the graph query throws', async () => {
    const base = validateAndParse(JSON.stringify([entry({ file: ABS_FILE, line: 42 })]), ABS_CTX);
    const cbm = stubCbm(async () => { throw new Error('CBM unreachable'); });
    const result = await verifyCitationsAgainstGraph(base, cbm);
    expect(result).toBe(base);
  });

  it('returns the result unchanged when there are no valid entries to check', async () => {
    const base = validateAndParse('not json', CTX);
    const cbm = stubCbm(async () => { throw new Error('should not be called'); });
    const result = await verifyCitationsAgainstGraph(base, cbm);
    expect(result).toBe(base);
  });
});

describe('renderMarkdown', () => {
  it('renders classes as H2 and methods as H3 with citations', () => {
    const result = validateAndParse(
      JSON.stringify([
        entry({ symbol: 'OrderService', type: 'class', line: 10, summary: 'Service.' }),
        entry(),
      ]),
      CTX
    );
    const md = renderMarkdown(result, '/ws/OrderService.java');
    expect(md).toContain('# Documentation: OrderService.java');
    expect(md).toContain('## OrderService');
    expect(md).toContain('### `OrderService.confirm`');
    expect(md).toContain('*src/main/java/com/example/OrderService.java:42*');
  });

  it('surfaces rejected entries in a warning section', () => {
    const result = validateAndParse(
      JSON.stringify([entry({ file: 'nope.java' })]),
      CTX
    );
    const md = renderMarkdown(result, '/ws/OrderService.java');
    expect(md).toContain('Rejected entries (1');
  });

  it('renders params, returns, throws and side effects when present', () => {
    const rich = entry({
      params: [{ name: 'id', type: 'Long', description: 'Order id' }],
      returns: 'Confirmation',
      throws: ['OrderNotFoundException'],
      sideEffects: ['Writes ORDERS table'],
    });
    const result = validateAndParse(JSON.stringify([rich]), CTX);
    const md = renderMarkdown(result, '/ws/OrderService.java');
    expect(md).toContain('**Parameters**');
    expect(md).toContain('- `id` *(Long)*: Order id');
    expect(md).toContain('**Returns**: Confirmation');
    expect(md).toContain('**Throws**');
    expect(md).toContain('**Side effects**');
  });
});
