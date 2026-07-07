import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeUrl, chat, getAllowPrivateNetwork } from '../src/ollama';
import { __resetConfig, __setConfig } from './mocks/vscode';

describe('getAllowPrivateNetwork', () => {
  afterEach(() => __resetConfig());

  it('defaults to false when unset', () => {
    expect(getAllowPrivateNetwork()).toBe(false);
  });

  it('reads the configured value', () => {
    __setConfig('docsAgent.allowPrivateNetworkOllama', true);
    expect(getAllowPrivateNetwork()).toBe(true);
  });
});

describe('assertSafeUrl — SSRF guard', () => {
  it('allows localhost and public hosts over http/https', () => {
    expect(() => assertSafeUrl('http://localhost:11434')).not.toThrow();
    expect(() => assertSafeUrl('http://127.0.0.1:11434')).not.toThrow();
    expect(() => assertSafeUrl('https://ollama.example.com')).not.toThrow();
  });

  it('rejects non-http protocols', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => assertSafeUrl('gopher://x')).toThrow(/http or https/);
  });

  it('rejects invalid URLs', () => {
    expect(() => assertSafeUrl('not a url')).toThrow(/Invalid Ollama URL/);
  });

  it('rejects link-local, RFC 1918, and CGNAT ranges', () => {
    for (const host of [
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5:11434',
      'http://172.16.3.4',
      'http://172.31.255.1',
      'http://192.168.1.10:11434',
      'http://100.64.0.1',
    ]) {
      expect(() => assertSafeUrl(host), host).toThrow(/restricted network address/);
    }
  });

  it('rejects IPv4-mapped IPv6 forms of blocked ranges', () => {
    expect(() => assertSafeUrl('http://[::ffff:169.254.169.254]')).toThrow(/restricted/);
    expect(() => assertSafeUrl('http://[::ffff:a9fe:a9fe]')).toThrow(/restricted/); // hex form of 169.254.169.254
  });

  it('rejects IPv6 loopback and metadata hosts', () => {
    expect(() => assertSafeUrl('http://[::1]:11434')).toThrow(/restricted/);
    expect(() => assertSafeUrl('http://[fd00:ec2::254]')).toThrow(/restricted/);
  });

  it('allows RFC 1918 ranges when allowPrivateNetwork is set', () => {
    for (const host of ['http://10.0.0.5:11434', 'http://172.16.3.4', 'http://192.168.1.60:11434']) {
      expect(() => assertSafeUrl(host, true), host).not.toThrow();
    }
  });

  it('still rejects link-local, metadata, and CGNAT even with allowPrivateNetwork', () => {
    for (const host of ['http://169.254.169.254/latest/meta-data', 'http://100.64.0.1', 'http://[fd00:ec2::254]']) {
      expect(() => assertSafeUrl(host, true), host).toThrow(/restricted network address/);
    }
  });
});

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const CONFIG = { url: 'http://localhost:11434', model: 'test-model' };

describe('chat — Ollama NDJSON stream parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('concatenates streamed message content and reads token counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjsonResponse([
        '{"message":{"content":"Hello"},"done":false}\n',
        '{"message":{"content":" world"},"done":false}\n',
        '{"message":{"content":""},"done":true,"prompt_eval_count":11,"eval_count":7}\n',
      ])
    ));

    const result = await chat([{ role: 'user', content: 'hi' }], CONFIG);
    expect(result.content).toBe('Hello world');
    expect(result.promptTokens).toBe(11);
    expect(result.completionTokens).toBe(7);
  });

  it('parses a final line that arrives without a trailing newline', async () => {
    // Ollama does not guarantee a trailing newline on the last NDJSON line.
    // The final buffered line must still be parsed after the stream closes.
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjsonResponse([
        '{"message":{"content":"partial"},"done":false}\n',
        '{"message":{"content":" end"},"done":true,"prompt_eval_count":5,"eval_count":3}',
      ])
    ));

    const result = await chat([{ role: 'user', content: 'hi' }], CONFIG);
    expect(result.content).toBe('partial end');
    expect(result.promptTokens).toBe(5);
    expect(result.completionTokens).toBe(3);
  });

  it('handles NDJSON lines split across network chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjsonResponse([
        '{"message":{"content":"Hel',
        'lo"},"done":false}\n{"message":{"content":"!"},"done":true,"prompt_eval_count":1,"eval_count":2}\n',
      ])
    ));

    const result = await chat([{ role: 'user', content: 'hi' }], CONFIG);
    expect(result.content).toBe('Hello!');
  });

  it('skips malformed lines without aborting the stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjsonResponse([
        'garbage not json\n',
        '{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ])
    ));

    const result = await chat([{ role: 'user', content: 'hi' }], CONFIG);
    expect(result.content).toBe('ok');
  });

  it('reports a model-not-found error with the pull hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":"model \'test-model\' not found"}', { status: 404 })
    ));

    await expect(chat([{ role: 'user', content: 'hi' }], CONFIG))
      .rejects.toThrow(/ollama pull test-model/);
  });

  it('wraps connection failures with a helpful message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    await expect(chat([{ role: 'user', content: 'hi' }], CONFIG))
      .rejects.toThrow(/Cannot reach Ollama at http:\/\/localhost:11434/);
  });
});
