// Thin HTTP wrapper around POST /rpc on the codebase-memory-mcp HTTP server.
// The server starts automatically alongside Claude Code (default port 9749).
// JSON-RPC 2.0 over HTTP — no subprocess spawning, no MCP handshake.

interface McpToolContent {
  type: string;
  text: string;
}

interface McpToolResult {
  content:  McpToolContent[];
  isError?: boolean;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id:      number;
  result?: McpToolResult;
  error?:  { code: number; message: string };
}

export class McpClient {
  private nextId = 1;
  readonly rpcUrl: string;
  readonly statusUrl: string;
  readonly layoutBaseUrl: string;

  constructor(port: number = 9749) {
    const base         = `http://localhost:${port}`;
    this.rpcUrl        = `${base}/rpc`;
    this.statusUrl     = `${base}/api/index-status`;
    this.layoutBaseUrl = `${base}/api/layout`;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await fetch(this.rpcUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method:  'tools/call',
          params:  { name, arguments: args },
        }),
      });
    } catch (err) {
      throw new Error(
        `Cannot reach codebase-memory-mcp at ${this.rpcUrl}. ` +
        `Is it running? (${(err as Error).message})`,
      );
    }

    if (!response.ok) {
      throw new Error(`CBM HTTP ${response.status}: ${await response.text()}`);
    }

    const msg = (await response.json()) as RpcResponse;
    if (msg.error) throw new Error(`CBM RPC error: ${msg.error.message}`);

    const result = msg.result;
    if (result?.isError) {
      throw new Error(
        `CBM tool "${name}" error: ${(result.content ?? []).map(c => c.text).join('')}`,
      );
    }
    return (result?.content ?? []).map(c => c.text ?? '').join('');
  }

  async getLayout(project: string, maxNodes = 300): Promise<unknown> {
    const url = `${this.layoutBaseUrl}?project=${encodeURIComponent(project)}&max_nodes=${maxNodes}`;
    let response: Response;
    try {
      const ac    = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      response    = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
    } catch (err) {
      throw new Error(`Cannot reach CBM layout at ${url}: ${(err as Error).message}`);
    }
    if (!response.ok) throw new Error(`CBM layout HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async ping(): Promise<boolean> {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 2000);
      const res = await fetch(this.statusUrl, { signal: ac.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }
}
