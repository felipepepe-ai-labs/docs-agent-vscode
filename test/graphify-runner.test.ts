import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GRAPHIFY_OUT_DIR, GRAPH_JSON_FILE, loadGraphJson } from '../src/graphify-runner';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-agent-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeGraph(content: string): void {
  const dir = path.join(root, GRAPHIFY_OUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, GRAPH_JSON_FILE), content);
}

describe('loadGraphJson', () => {
  it('returns a promise — reads must not block the extension host', () => {
    writeGraph('{"nodes":[]}');
    expect(loadGraphJson(root)).toBeInstanceOf(Promise);
  });

  it('parses a valid graph.json', async () => {
    writeGraph(JSON.stringify({ nodes: [{ id: 'A', label: 'A' }], links: [] }));
    const json = await loadGraphJson(root);
    expect(json?.nodes).toHaveLength(1);
    expect(json?.nodes[0].id).toBe('A');
  });

  it('resolves null when the file is missing', async () => {
    expect(await loadGraphJson(root)).toBeNull();
  });

  it('resolves null when "nodes" is not an array', async () => {
    writeGraph('{"nodes": 42}');
    expect(await loadGraphJson(root)).toBeNull();
  });

  it('resolves null on malformed JSON', async () => {
    writeGraph('{oops');
    expect(await loadGraphJson(root)).toBeNull();
  });
});
