import * as path from 'path';
import { McpClient } from './mcp-client';

// ── Response shapes ────────────────────────────────────────────────────────────

export interface CbmNode {
  qualified_name: string;
  name:           string;
  label:          string;
  file?:          string;
  line?:          number;
  degree?:        number;
}

export interface CbmLayoutNode {
  id:        number;
  x:         number;
  y:         number;
  z:         number;
  label:     string;
  name:      string;
  file_path: string;
  size:      number;
  color:     string;
}

export interface CbmLayoutEdge {
  source: number;
  target: number;
  type:   string;
}

export interface CbmLayoutResult {
  nodes:       CbmLayoutNode[];
  edges:       CbmLayoutEdge[];
  total_nodes: number;
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
  private readonly client:  McpClient;
  readonly project:         string;
  readonly repoPath:        string;

  constructor(client: McpClient, workspaceRoot: string) {
    this.client   = client;
    this.repoPath = workspaceRoot;
    this.project  = path.basename(workspaceRoot);
  }

  /** Trigger a background re-index (e.g. from the dashboard Re-index button). */
  async reindex(mode: 'full' | 'moderate' | 'fast' = 'moderate'): Promise<void> {
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

  async fetchLayout(maxNodes = 300): Promise<CbmLayoutResult> {
    const raw = await this.client.getLayout(this.project, maxNodes);
    return raw as CbmLayoutResult;
  }

  async detectChanges(since?: string): Promise<string> {
    return this.client.callTool('detect_changes', {
      project: this.project,
      ...(since ? { since } : {}),
    });
  }

  // No dispose needed — HTTP connections are stateless.
  dispose(): void {}
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Connect to the already-running CBM HTTP server and return a manager for workspaceRoot. */
export function createCbmManager(workspaceRoot: string, port = 9749): CbmManager {
  return new CbmManager(new McpClient(port), workspaceRoot);
}

/** Returns true if the CBM HTTP server is reachable on the given port. */
export async function isCbmAlive(port = 9749): Promise<boolean> {
  return new McpClient(port).ping();
}
