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

// Ports CBM's own cbm_project_name_from_path (src/pipeline/fqn.c) byte-for-byte.
// CBM identifies a project by its FULL path, not its basename — every server
// endpoint (e.g. GET /api/layout, http_server.c handle_layout) does an exact
// string lookup against this slug with no fuzzy fallback, so any mismatch here
// is a hard "project not found" on every single CBM call this class makes.
export function cbmProjectNameFromPath(absPath: string): string {
  if (!absPath) return 'root';

  const hex = '0123456789abcdef';
  let mapped = '';
  for (const byte of Buffer.from(absPath, 'utf8')) {
    const isSafe =
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2e || byte === 0x5f || byte === 0x2d; // . _ -
    if (isSafe) {
      mapped += String.fromCharCode(byte);
    } else if (byte >= 0x80) {
      // Non-ASCII bytes are transliterated to hex, not dropped, so multi-byte
      // UTF-8 segments (e.g. CJK paths) don't collide or vanish (CBM issue #571).
      mapped += hex[(byte >> 4) & 0xf] + hex[byte & 0xf];
    } else {
      mapped += '-';
    }
  }

  // Collapse consecutive dashes, and consecutive dots, into one.
  let collapsed = '';
  let prev = '';
  for (const ch of mapped) {
    if ((ch === '-' && prev === '-') || (ch === '.' && prev === '.')) continue;
    collapsed += ch;
    prev = ch;
  }

  const trimmed = collapsed.replace(/^[-.]+/, '').replace(/-+$/, '');
  return trimmed || 'root';
}

// ── Manager ────────────────────────────────────────────────────────────────────

export class CbmManager {
  private readonly client:  McpClient;
  readonly project:         string;
  readonly repoPath:        string;

  constructor(client: McpClient, workspaceRoot: string) {
    this.client   = client;
    this.repoPath = workspaceRoot;
    this.project  = cbmProjectNameFromPath(workspaceRoot);
  }

  /** Trigger a background re-index (e.g. from the dashboard Re-index button). */
  async reindex(mode: 'full' | 'moderate' | 'fast' = 'moderate'): Promise<void> {
    await this.client.callTool('index_repository', { repo_path: this.repoPath, mode });
  }

  /**
   * Whether this project has actually been indexed by CBM — distinct from the
   * server being reachable (isCbmAlive only checks the HTTP process, not any
   * particular project). Any failure (project never indexed, server error,
   * unexpected response shape) is treated as "not indexed" — this is a status
   * signal, not something callers should need to distinguish further.
   */
  async indexStatus(): Promise<{ indexed: boolean; status?: string }> {
    try {
      const raw = await this.client.callTool('index_status', { project: this.project });
      const parsed = JSON.parse(raw) as { status?: string };
      return { indexed: parsed.status === 'ready', status: parsed.status };
    } catch {
      return { indexed: false };
    }
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

// ── Path conventions ─────────────────────────────────────────────────────────
// CBM indexes and returns file_path as a POSIX-style path relative to the repo
// root (e.g. "src/context.ts") — never the absolute paths the extension works
// with elsewhere (document.uri.fsPath). Every Cypher query or result touching
// file_path must convert through these helpers or it will silently match nothing.

export function toCbmRelativePath(absPath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, absPath).split(path.sep).join('/');
}

export function fromCbmRelativePath(relPath: string, workspaceRoot: string): string {
  return path.join(workspaceRoot, ...relPath.split('/'));
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
