import * as cp from 'child_process';
import * as path from 'path';
import { McpClient } from './mcp-client';

// ── Response shapes from codebase-memory-mcp tools ────────────────────────────

export interface CbmNode {
  qualified_name: string;
  name:           string;
  label:          string;
  file?:          string;
  line?:          number;
  degree?:        number;
}

export interface CbmSearchResult {
  results:          CbmNode[];
  semantic_results?: CbmNode[];
  total:            number;
  has_more:         boolean;
}

export interface CbmQueryResult {
  rows:  Record<string, unknown>[];
  total: number;
}

// ── Manager ────────────────────────────────────────────────────────────────────

export class CbmManager {
  private readonly client:   McpClient;
  readonly project:          string;   // project name = basename(workspaceRoot)
  private readonly repoPath: string;

  constructor(client: McpClient, workspaceRoot: string) {
    this.client   = client;
    this.repoPath = workspaceRoot;
    this.project  = path.basename(workspaceRoot);
  }

  async index(mode: 'full' | 'moderate' | 'fast' = 'moderate'): Promise<void> {
    await this.client.callTool('index_repository', { repo_path: this.repoPath, mode });
  }

  async getArchitecture(aspects?: string[]): Promise<string> {
    return this.client.callTool('get_architecture', {
      project: this.project,
      ...(aspects?.length ? { aspects } : {}),
    });
  }

  async searchGraph(params: {
    query?:        string;
    name_pattern?: string;
    label?:        string;
    file_pattern?: string;
    limit?:        number;
    offset?:       number;
  }): Promise<CbmSearchResult> {
    const raw = await this.client.callTool('search_graph', { project: this.project, ...params });
    return JSON.parse(raw) as CbmSearchResult;
  }

  async tracePath(
    functionName: string,
    opts?: {
      mode?:      'calls' | 'data_flow' | 'cross_service';
      direction?: 'inbound' | 'outbound' | 'both';
      depth?:     number;
    },
  ): Promise<string> {
    return this.client.callTool('trace_path', {
      function_name: functionName,
      project:       this.project,
      ...opts,
    });
  }

  async getCodeSnippet(qualifiedName: string): Promise<string> {
    return this.client.callTool('get_code_snippet', {
      qualified_name: qualifiedName,
      project:        this.project,
    });
  }

  async queryGraph(cypher: string, maxRows = 5000): Promise<CbmQueryResult> {
    const raw = await this.client.callTool('query_graph', {
      query:    cypher,
      project:  this.project,
      max_rows: maxRows,
    });
    return JSON.parse(raw) as CbmQueryResult;
  }

  async detectChanges(since?: string): Promise<string> {
    return this.client.callTool('detect_changes', {
      project: this.project,
      ...(since ? { since } : {}),
    });
  }

  async reindex(mode: 'full' | 'moderate' | 'fast' = 'moderate'): Promise<void> {
    // detect_changes to understand scope, then re-index
    try { await this.detectChanges('HEAD~1'); } catch { /* non-fatal */ }
    await this.index(mode);
  }

  dispose(): void { this.client.dispose(); }
}

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

export async function findCbm(): Promise<string | null> {
  return new Promise(resolve => {
    cp.exec(
      process.platform === 'win32' ? 'where codebase-memory-mcp' : 'which codebase-memory-mcp',
      (_err, stdout) => resolve(stdout.trim().split(/\r?\n/)[0] || null),
    );
  });
}

export async function startCbm(bin: string, workspaceRoot: string): Promise<CbmManager> {
  const client = new McpClient(bin, workspaceRoot);
  await client.initialize();
  return new CbmManager(client, workspaceRoot);
}
