import { describe, expect, it } from 'vitest';
import { CbmManager, cbmProjectNameFromPath } from '../src/cbm-runner';
import type { McpClient } from '../src/mcp-client';

function stubClient(onCallTool: (name: string, args: Record<string, unknown>) => Promise<string>): McpClient {
  return { callTool: onCallTool } as unknown as McpClient;
}

describe('cbmProjectNameFromPath — must match CBM\'s cbm_project_name_from_path exactly', () => {
  // Expected values below are not synthetic — they are the real project slugs
  // CBM reports via list_projects for these exact repo paths (verified live).
  it('slugs a real nested repo path the same way CBM does', () => {
    expect(cbmProjectNameFromPath('/mnt/nas/sources/node/vscode-extension/docs-agent-vscode'))
      .toBe('mnt-nas-sources-node-vscode-extension-docs-agent-vscode');
  });

  it('preserves letter casing', () => {
    expect(cbmProjectNameFromPath('/mnt/nas/Obsidian')).toBe('mnt-nas-Obsidian');
  });

  it('keeps dashes already present in path segments and collapses only the ones it introduces', () => {
    expect(cbmProjectNameFromPath('/mnt/nas/sources/media/video-transcriptor'))
      .toBe('mnt-nas-sources-media-video-transcriptor');
  });

  it('returns "root" for an empty path', () => {
    expect(cbmProjectNameFromPath('')).toBe('root');
  });

  it('maps spaces and other unsafe ASCII characters to a single dash, collapsing runs', () => {
    // ':' and '\' each map to '-' individually, then the run of two collapses to one.
    expect(cbmProjectNameFromPath('C:\\Users\\dev\\my project')).toBe('C-Users-dev-my-project');
  });

  it('transliterates non-ASCII bytes to hex instead of dropping them', () => {
    // 'é' is 0xC3 0xA9 in UTF-8.
    expect(cbmProjectNameFromPath('/tmp/café')).toBe('tmp-cafc3a9');
  });

  it('trims leading dashes/dots and trailing dashes', () => {
    expect(cbmProjectNameFromPath('/a/b/')).toBe('a-b');
  });
});

describe('CbmManager.project — regression: must be the full-path slug, not basename', () => {
  it('does not use path.basename, which would produce a project key CBM never indexes under', () => {
    const mgr = new CbmManager(stubClient(async () => '{}'), '/mnt/nas/sources/node/vscode-extension/docs-agent-vscode');
    expect(mgr.project).toBe('mnt-nas-sources-node-vscode-extension-docs-agent-vscode');
    expect(mgr.project).not.toBe('docs-agent-vscode');
  });
});

describe('CbmManager.indexStatus', () => {
  it('reports indexed when CBM returns status "ready"', async () => {
    const mgr = new CbmManager(
      stubClient(async () => JSON.stringify({ status: 'ready', nodes: 100, edges: 200 })),
      '/ws',
    );
    expect(await mgr.indexStatus()).toEqual({ indexed: true, status: 'ready' });
  });

  it('reports not indexed for any non-"ready" status', async () => {
    const mgr = new CbmManager(
      stubClient(async () => JSON.stringify({ status: 'indexing' })),
      '/ws',
    );
    expect(await mgr.indexStatus()).toEqual({ indexed: false, status: 'indexing' });
  });

  it('reports not indexed when the project has never been indexed (CBM throws)', async () => {
    const mgr = new CbmManager(
      stubClient(async () => { throw new Error('project not found or not indexed'); }),
      '/ws',
    );
    expect(await mgr.indexStatus()).toEqual({ indexed: false });
  });
});
