import * as vscode from 'vscode';
import { chat as ollamaChat } from './ollama';

export type Provider = 'ollama' | 'vscode-lm';

export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmConfig {
  provider:       Provider;
  ollamaUrl:      string;
  ollamaModel:    string;
  vscodeLmFamily: string;  // e.g. "gpt-4o", "claude-3.5-sonnet" — empty = first available
}

export function getLlmConfig(): LlmConfig {
  const cfg = vscode.workspace.getConfiguration('docsAgent');
  return {
    provider:       cfg.get<Provider>('provider',       'ollama'),
    ollamaUrl:      cfg.get<string>('ollamaUrl',        'http://localhost:11434'),
    ollamaModel:    cfg.get<string>('model',            'qwen3:35b'),
    vscodeLmFamily: cfg.get<string>('vscodeLmFamily',   ''),
  };
}

export async function chat(
  messages: LlmMessage[],
  config: LlmConfig,
  token?: vscode.CancellationToken
): Promise<string> {
  if (config.provider === 'vscode-lm') {
    return chatVsCodeLm(messages, config.vscodeLmFamily, token);
  }
  return ollamaChat(
    messages.map(m => ({ role: m.role, content: m.content })),
    { url: config.ollamaUrl, model: config.ollamaModel }
  );
}

async function chatVsCodeLm(
  messages: LlmMessage[],
  family: string,
  token?: vscode.CancellationToken
): Promise<string> {
  const selector = family ? { family } : {};
  const models   = await vscode.lm.selectChatModels(selector);

  if (!models.length) {
    const hint = family ? `family "${family}"` : 'any available model';
    throw new Error(
      `No VS Code language model found (${hint}). ` +
      `Make sure GitHub Copilot (or another LM provider) is installed and signed in.`
    );
  }

  const model = models[0];

  // VS Code LM has no "system" role — prepend system content to the first user message.
  const lmMessages: vscode.LanguageModelChatMessage[] = [];
  let pendingSystem = '';

  for (const msg of messages) {
    if (msg.role === 'system') {
      pendingSystem += msg.content + '\n\n';
    } else {
      const text = pendingSystem ? pendingSystem + msg.content : msg.content;
      lmMessages.push(vscode.LanguageModelChatMessage.User(text));
      pendingSystem = '';
    }
  }

  const cts = new vscode.CancellationTokenSource();
  try {
    const response = await model.sendRequest(lmMessages, {}, token ?? cts.token);
    let result = '';
    for await (const chunk of response.text) {
      result += chunk;
    }
    return result;
  } finally {
    cts.dispose();
  }
}
