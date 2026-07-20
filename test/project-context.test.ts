import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../src/project-context';
import type { CbmManager, CbmQueryResult } from '../src/cbm-runner';

function stubCbm(onQuery?: (cypher: string) => Promise<CbmQueryResult>): CbmManager {
  return {
    queryGraph: onQuery ?? (async () => ({ rows: [], total: 0 })),
  } as unknown as CbmManager;
}

describe('buildProjectContext — graph-ranked file selection', () => {
  let root: string;
  let hotFile: string;   // no naming-convention signal, but high call-graph degree
  let namedFile: string; // strong naming-convention signal, but zero call-graph degree
  let testFile: string;  // excluded regardless of graph score

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-agent-proj-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sample' }));
    hotFile = path.join(root, 'Widget.ts');
    namedFile = path.join(root, 'RarelyUsedController.ts');
    testFile = path.join(root, 'Widget.test.ts');
    fs.writeFileSync(hotFile, 'export class Widget {}');
    fs.writeFileSync(namedFile, 'export class RarelyUsedController {}');
    fs.writeFileSync(testFile, 'describe("Widget", () => {});');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ranks a high call-graph-degree file above a merely well-named one when CBM is available', async () => {
    // CBM's file_path is relative to the repo root — not the absolute paths on disk.
    const cbm = stubCbm(async () => ({
      rows: [
        { caller: 'Widget.ts', callee: 'Widget.ts' },
        { caller: 'Widget.ts', callee: 'Widget.ts' },
        { caller: 'Widget.ts', callee: 'Widget.ts' },
      ],
      total: 3,
    }));

    const ctx = await buildProjectContext(root, cbm);
    const order = ctx.sourceFiles.map(f => f.path);
    expect(order.indexOf('Widget.ts')).toBeLessThan(order.indexOf('RarelyUsedController.ts'));
  });

  it('excludes test files regardless of graph degree', async () => {
    const cbm = stubCbm(async () => ({
      rows: [{ caller: 'Widget.test.ts', callee: 'Widget.test.ts' }],
      total: 1,
    }));

    const ctx = await buildProjectContext(root, cbm);
    expect(ctx.sourceFiles.some(f => f.path === 'Widget.test.ts')).toBe(false);
  });

  it('falls back to naming-convention ranking alone when CBM is not provided', async () => {
    const ctx = await buildProjectContext(root);
    const order = ctx.sourceFiles.map(f => f.path);
    expect(order.indexOf('RarelyUsedController.ts')).toBeLessThan(order.indexOf('Widget.ts'));
  });

  it('falls back to naming-convention ranking when the graph query throws', async () => {
    const cbm = stubCbm(async () => { throw new Error('CBM unreachable'); });
    const ctx = await buildProjectContext(root, cbm);
    const order = ctx.sourceFiles.map(f => f.path);
    expect(order.indexOf('RarelyUsedController.ts')).toBeLessThan(order.indexOf('Widget.ts'));
  });
});
