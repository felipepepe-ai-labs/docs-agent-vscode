import { describe, expect, it } from 'vitest';
import { normalizeMermaidBlocks } from '../src/writer';

describe('normalizeMermaidBlocks', () => {
  it('converts literal \\n inside node labels to <br/>', () => {
    const md = '```mermaid\ngraph TD\n  A[line1\\nline2] --> B[ok]\n```';
    const fixed = normalizeMermaidBlocks(md);
    expect(fixed).toContain('A[line1<br/>line2]');
    expect(fixed).toContain('B[ok]');
  });

  it('quotes labels containing parentheses', () => {
    const md = '```mermaid\ngraph TD\n  A[calls foo()] --> B\n```';
    const fixed = normalizeMermaidBlocks(md);
    expect(fixed).toContain('A["calls foo()"]');
  });

  it('does not double-quote already quoted labels', () => {
    const md = '```mermaid\ngraph TD\n  A["already (quoted)"] --> B\n```';
    expect(normalizeMermaidBlocks(md)).toContain('A["already (quoted)"]');
  });

  it('leaves markdown outside mermaid blocks untouched', () => {
    const md = 'Text with [brackets (and parens)] stays.\n```mermaid\ngraph TD\n  A[x()] --> B\n```\nAfter [more (text)].';
    const fixed = normalizeMermaidBlocks(md);
    expect(fixed).toContain('Text with [brackets (and parens)] stays.');
    expect(fixed).toContain('After [more (text)].');
    expect(fixed).toContain('A["x()"]');
  });
});
