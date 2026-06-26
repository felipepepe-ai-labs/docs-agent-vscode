import { workspace } from 'vscode';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaConfig {
  url: string;
  model: string;
}

export function getOllamaConfig(): OllamaConfig {
  const cfg = workspace.getConfiguration('docsAgent');
  return {
    url: cfg.get<string>('ollamaUrl', 'http://localhost:11434'),
    model: cfg.get<string>('model', 'qwen3:35b'),
  };
}

function resolveIpv4Mapped(hostname: string): string {
  // ::ffff:a.b.c.d — dotted decimal form
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(hostname);
  if (dotted) return dotted[1];
  // ::ffff:aabb:ccdd — hex form
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return hostname;
}

export function assertSafeUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid Ollama URL: ${url}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Ollama URL must use http or https. Got: ${parsed.protocol}`);
  }
  // Strip IPv6 brackets, normalize to lowercase, resolve IPv4-mapped IPv6
  const hostname = resolveIpv4Mapped(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
  if (hostname.startsWith('169.254.') || hostname === 'fd00:ec2::254') {
    throw new Error('Ollama URL must not target cloud metadata endpoints.');
  }
}

export async function chat(
  messages: OllamaMessage[],
  config: OllamaConfig,
  token?: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => void }
): Promise<string> {
  assertSafeUrl(config.url);

  const controller = new AbortController();
  if (token) {
    if (token.isCancellationRequested) { controller.abort(); }
    else { token.onCancellationRequested(() => controller.abort()); }
  }

  let response: Response;
  try {
    response = await fetch(`${config.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Cancelled');
    throw new Error(
      `Cannot reach Ollama at ${config.url}. Is it running? (${(err as Error).message})`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 404 && body.includes('model')) {
      throw new Error(
        `Model "${config.model}" not found in Ollama. Run: ollama pull ${config.model}`
      );
    }
    throw new Error(`Ollama returned HTTP ${response.status}: ${body}`);
  }

  if (!response.body) throw new Error('Ollama response has no body');
  const chunks: string[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let leftover = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    leftover += decoder.decode(value, { stream: true });
    const lines = leftover.split('\n');
    leftover = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed['error']) throw new Error(`Ollama error: ${parsed['error']}`);
        const content = (parsed['message'] as Record<string, unknown> | undefined)?.['content'];
        if (typeof content === 'string') chunks.push(content);
      } catch (e) {
        if ((e as Error).message.startsWith('Ollama error:')) throw e;
        // malformed line — skip
      }
    }
  }

  return chunks.join('');
}
