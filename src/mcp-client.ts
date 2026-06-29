import * as cp from 'child_process';

// JSON-RPC 2.0 over stdio with Content-Length framing (MCP stdio transport).
// Each frame: "Content-Length: N\r\n\r\n<N bytes of UTF-8 JSON>"

interface RpcMessage {
  jsonrpc: '2.0';
  id?:     number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?:  { code: number; message: string };
}

interface McpToolContent {
  type: string;
  text: string;
}

interface McpToolResult {
  content:  McpToolContent[];
  isError?: boolean;
}

export class McpClient {
  private readonly proc: cp.ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject:  (e: Error)   => void;
  }>();
  private rxBuf = Buffer.alloc(0);

  constructor(bin: string, workspaceRoot: string) {
    this.proc = cp.spawn(bin, [], {
      cwd:   workspaceRoot,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => this.consume(chunk));
    this.proc.stderr!.on('data', (chunk: Buffer) =>
      console.error('[Docs Agent/CBM]', chunk.toString().trimEnd()),
    );
    this.proc.on('error', err  => this.flush(err));
    this.proc.on('close', code => this.flush(new Error(`codebase-memory-mcp exited (code ${code})`)));
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities:    {},
      clientInfo:      { name: 'docs-agent-vscode', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as McpToolResult;
    if (result?.isError) {
      const msg = (result.content ?? []).map(c => c.text).join('');
      throw new Error(`CBM tool "${name}" error: ${msg}`);
    }
    return (result?.content ?? []).map(c => c.text ?? '').join('');
  }

  dispose(): void {
    this.flush(new Error('McpClient disposed'));
    try { this.proc.kill(); } catch { /* process may already be gone */ }
  }

  private rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: object): void {
    const body = JSON.stringify(msg);
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  private consume(chunk: Buffer): void {
    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
    // Drain as many complete frames as the buffer holds.
    while (true) {
      const hdrEnd = this.rxBuf.indexOf('\r\n\r\n');
      if (hdrEnd === -1) break;
      const header   = this.rxBuf.slice(0, hdrEnd).toString('utf8');
      const lenMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lenMatch) { this.rxBuf = this.rxBuf.slice(hdrEnd + 4); break; }
      const bodyLen   = parseInt(lenMatch[1], 10);
      const bodyStart = hdrEnd + 4;
      if (this.rxBuf.length < bodyStart + bodyLen) break; // wait for more data
      const body = this.rxBuf.slice(bodyStart, bodyStart + bodyLen).toString('utf8');
      this.rxBuf = this.rxBuf.slice(bodyStart + bodyLen);
      try {
        const msg = JSON.parse(body) as RpcMessage;
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
        }
      } catch { /* malformed frame — skip */ }
    }
  }

  private flush(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
