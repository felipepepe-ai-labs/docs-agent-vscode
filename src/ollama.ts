import { workspace } from 'vscode';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaConfig {
  url: string;
  model: string;
  allowPrivateNetwork: boolean;
}

// Read from *global* scope only (never workspace/workspaceFolder). A malicious
// repo can ship a `.vscode/settings.json` that silently repoints `ollamaUrl`
// at an internal service — if this toggle honored workspace scope too, that
// same file could flip it on and defeat the RFC 1918 guard below. Reading
// only the user's own global setting means opting in requires an action the
// project being opened cannot take on the user's behalf.
export function getAllowPrivateNetwork(): boolean {
  const cfg = workspace.getConfiguration('docsAgent');
  return cfg.inspect<boolean>('allowPrivateNetworkOllama')?.globalValue ?? false;
}

export function getOllamaConfig(): OllamaConfig {
  const cfg = workspace.getConfiguration('docsAgent');
  return {
    url: cfg.get<string>('ollamaUrl', 'http://localhost:11434'),
    model: cfg.get<string>('model', 'qwen3:35b'),
    allowPrivateNetwork: getAllowPrivateNetwork(),
  };
}

function resolveIpv4Mapped(hostname: string): string {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(hostname);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return hostname;
}

// Never a legitimate manually-configured Ollama target: link-local/cloud-metadata,
// CGNAT, and "this network" addresses. Blocked regardless of `allowPrivateNetwork`.
const ALWAYS_BLOCKED = [
  /^169\.254\./,                    // link-local / AWS metadata
  /^100\.64\./,                     // CGNAT
  /^0\./,                           // "this" network
];

// RFC 1918 private ranges — a completely normal home/office LAN setup (e.g.
// Ollama running on another machine on the same network). Only blocked by
// default to stop a malicious repo's workspace settings from silently
// redirecting requests into the user's internal network (see
// getAllowPrivateNetwork). Gated behind `allowPrivateNetwork`.
const PRIVATE_NETWORK_BLOCKED = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

const BLOCKED_EXACT = new Set(['fd00:ec2::254', '::1', 'fe80::1']);

export function assertSafeUrl(url: string, allowPrivateNetwork = false): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid Ollama URL: ${url}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Ollama URL must use http or https. Got: ${parsed.protocol}`);
  }
  const hostname = resolveIpv4Mapped(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''));

  const blocked = ALWAYS_BLOCKED.some(r => r.test(hostname))
    || BLOCKED_EXACT.has(hostname)
    || (!allowPrivateNetwork && PRIVATE_NETWORK_BLOCKED.some(r => r.test(hostname)));

  if (blocked) {
    throw new Error(`Ollama URL targets a restricted network address: ${hostname}`);
  }
}

export interface OllamaResult {
  content:          string;
  promptTokens:     number;
  completionTokens: number;
}

export async function chat(messages: OllamaMessage[], config: OllamaConfig): Promise<OllamaResult> {
  assertSafeUrl(config.url, config.allowPrivateNetwork);

  let response: Response;

  try {
    response = await fetch(`${config.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, stream: true }),
    });
  } catch (err) {
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

  const chunks: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let promptTokens     = 0;
  let completionTokens = 0;
  let leftover         = '';

  const consumeLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const msg = parsed['message'] as Record<string, unknown> | undefined;
      if (typeof msg?.['content'] === 'string') {
        chunks.push(msg['content']);
      }
      if (parsed['done'] === true) {
        promptTokens     = (parsed['prompt_eval_count'] as number) ?? 0;
        completionTokens = (parsed['eval_count']        as number) ?? 0;
      }
    } catch {
      // malformed line — skip
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    leftover += decoder.decode(value, { stream: true });
    const lines = leftover.split('\n');
    leftover = lines.pop() ?? '';

    for (const line of lines) consumeLine(line);
  }

  // The stream is not guaranteed to end with a newline — flush the tail,
  // which typically carries the done:true line with the token counts.
  leftover += decoder.decode();
  consumeLine(leftover);

  return { content: chunks.join(''), promptTokens, completionTokens };
}
