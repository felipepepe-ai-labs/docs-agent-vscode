declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

export {};

interface Settings {
  provider:       string;
  ollamaUrl:      string;
  model:          string;
  vscodeLmFamily: string;
  docsFolder:     string;
  language:       string;
}

interface VsCodeModel { id: string; family: string; name: string; vendor: string }

// ── DOM refs ──────────────────────────────────────────────────────────────────
const radios          = document.querySelectorAll<HTMLInputElement>('input[name="provider"]');
const sectionOllama   = document.getElementById('section-ollama')!;
const sectionVscode   = document.getElementById('section-vscode')!;

const ollamaUrlInput  = document.getElementById('ollamaUrl')       as HTMLInputElement;
const modelInput      = document.getElementById('model')           as HTMLInputElement;
const modelList       = document.getElementById('model-list')      as HTMLDataListElement;
const testOllamaBtn   = document.getElementById('testOllama')      as HTMLButtonElement;
const refreshOllamaBtn= document.getElementById('refreshOllama')   as HTMLButtonElement;

const vscodeFamilyInput = document.getElementById('vscodeLmFamily') as HTMLInputElement;
const vscodeModelList   = document.getElementById('vscode-model-list') as HTMLDataListElement;
const listVsCodeBtn     = document.getElementById('listVsCode')    as HTMLButtonElement;

const folderInput     = document.getElementById('docsFolder')      as HTMLInputElement;
const languageSelect  = document.getElementById('language')        as HTMLSelectElement;
const saveBtn         = document.getElementById('save')            as HTMLButtonElement;
const statusEl        = document.getElementById('status')!;

// ── Provider toggle ───────────────────────────────────────────────────────────
function applyProvider(provider: string): void {
  const isOllama = provider === 'ollama';
  sectionOllama.style.display = isOllama ? '' : 'none';
  sectionVscode.style.display = isOllama ? 'none' : '';
}

Array.from(radios).forEach(r => r.addEventListener('change', () => applyProvider(r.value)));

function selectedProvider(): string {
  return Array.from(radios).find(r => r.checked)?.value ?? 'ollama';
}

// ── Init message ──────────────────────────────────────────────────────────────
window.addEventListener('message', ({ data }: MessageEvent) => {
  if (data.type === 'init') {
    const s: Settings = data.settings;
    Array.from(radios).forEach(r => { r.checked = r.value === s.provider; });
    ollamaUrlInput.value    = s.ollamaUrl;
    modelInput.value        = s.model;
    vscodeFamilyInput.value = s.vscodeLmFamily;
    folderInput.value       = s.docsFolder;
    languageSelect.value    = s.language;
    applyProvider(s.provider);
  }

  if (data.type === 'testResult') {
    if (data.ok) setStatus(`Connected — Ollama ${data.version ?? ''}`, 'ok');
    else         setStatus(`Cannot reach Ollama: ${data.error}`, 'error');
  }

  if (data.type === 'ollamaModels') {
    if (data.models?.length) {
      modelList.innerHTML = (data.models as string[]).map(m => `<option value="${esc(m)}">`).join('');
      setStatus(`${data.models.length} model(s) found.`, 'ok');
    } else {
      setStatus(data.error ?? 'No Ollama models found.', 'error');
    }
  }

  if (data.type === 'vsCodeModels') {
    if (data.models?.length) {
      const list = data.models as VsCodeModel[];
      vscodeModelList.innerHTML = list.map(m => `<option value="${esc(m.family)}" label="${esc(m.name)}">`).join('');
      setStatus(`${list.length} VS Code model(s) available.`, 'ok');
    } else {
      setStatus(data.error ?? 'No VS Code models found. Is GitHub Copilot installed?', 'error');
    }
  }
});

// ── Actions ───────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  vscode.postMessage({
    type: 'save',
    settings: {
      provider:       selectedProvider(),
      ollamaUrl:      ollamaUrlInput.value.trim(),
      model:          modelInput.value.trim(),
      vscodeLmFamily: vscodeFamilyInput.value.trim(),
      docsFolder:     folderInput.value.trim(),
      language:       languageSelect.value,
    } satisfies Settings,
  });
  flash('Settings saved.', 'ok');
});

testOllamaBtn.addEventListener('click', () => {
  setStatus('Testing connection…', 'pending');
  vscode.postMessage({ type: 'testOllama', url: ollamaUrlInput.value.trim() });
});

refreshOllamaBtn.addEventListener('click', () => {
  setStatus('Fetching Ollama models…', 'pending');
  vscode.postMessage({ type: 'refreshOllama', url: ollamaUrlInput.value.trim() });
});

listVsCodeBtn.addEventListener('click', () => {
  setStatus('Querying VS Code language models…', 'pending');
  vscode.postMessage({ type: 'listVsCodeModels' });
});

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(msg: string, kind: 'ok' | 'error' | 'pending'): void {
  statusEl.textContent = msg;
  statusEl.className   = `status ${kind}`;
}

function flash(msg: string, kind: 'ok' | 'error'): void {
  setStatus(msg, kind);
  setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status'; }, 2500);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
