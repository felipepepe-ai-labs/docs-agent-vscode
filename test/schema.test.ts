import { describe, expect, it } from 'vitest';
import { renderMarkdown, validateAndParse } from '../src/schema';

const CTX = new Set(['src/main/java/com/example/OrderService.java']);

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
