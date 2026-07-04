import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const GRAPHIFY_OUT_DIR = 'graphify-out';
export const GRAPH_JSON_FILE  = 'graph.json';

// ── graphify graph.json types (NetworkX node-link format) ─────────────────────

export interface GraphifyNode {
  id: string;
  label: string;
  source_file?: string;
  source_location?: string;
  file_type?: string;
  community?: number;
  community_name?: string;
}

export interface GraphifyLink {
  source: string;
  target: string;
  relation: string;
  confidence?: string;
}

export interface GraphifyJson {
  nodes: GraphifyNode[];
  links?: GraphifyLink[];
  edges?: GraphifyLink[];   // some graphify exports use "edges" instead of "links"
  directed?: boolean;
  multigraph?: boolean;
}

// ── Resolved binary (pinned once at activation) ───────────────────────────────

let _graphifyBin: string | null = null;

export function setCachedBin(bin: string): void {
  _graphifyBin = bin;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function graphOutPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, GRAPHIFY_OUT_DIR, GRAPH_JSON_FILE);
}

// ── Installation check ────────────────────────────────────────────────────────

export function findGraphify(): Promise<string | null> {
  return new Promise(resolve => {
    cp.exec(
      process.platform === 'win32' ? 'where graphify' : 'which graphify',
      (_err, stdout) => resolve(stdout.trim().split(/\r?\n/)[0] || null),
    );
  });
}

export async function promptInstall(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Docs Agent: graphify is not installed. It is required for code graph extraction.',
    'Install (uv)',
    'Install (pip)',
  );
  if (!choice) return;
  const term = vscode.window.createTerminal('Docs Agent — Install graphify');
  term.show();
  term.sendText(choice === 'Install (uv)'
    ? 'uv tool install graphify'
    : 'pip install graphify',
  );
}

// ── Subprocess ────────────────────────────────────────────────────────────────

export function runGraphify(
  workspaceRoot: string,
  update: boolean,
  progress?: vscode.Progress<{ message?: string }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = _graphifyBin;
    if (!bin) {
      reject(new Error('graphify binary not resolved — activate the extension first'));
      return;
    }
    const args = update ? ['update', '.'] : ['.'];
    const proc = cp.spawn(bin, args, {
      cwd:   workspaceRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line && progress) progress.report({ message: line.slice(0, 100) });
    });

    proc.on('error', err => reject(new Error(`graphify failed to start: ${err.message}`)));
    proc.on('close', code => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`graphify exited with code ${code}`));
    });
  });
}

// ── graph.json metadata ───────────────────────────────────────────────────────

export interface GraphInfo {
  exists:    boolean;
  mtimeMs:   number | null;
  sizeBytes: number | null;
}

export function getGraphInfo(workspaceRoot: string): GraphInfo {
  const p = graphOutPath(workspaceRoot);
  try {
    const stat = fs.statSync(p);
    return { exists: true, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  } catch {
    return { exists: false, mtimeMs: null, sizeBytes: null };
  }
}

// ── graph.json I/O ────────────────────────────────────────────────────────────

const MAX_GRAPH_JSON_BYTES = 50 * 1024 * 1024; // 50 MB

export async function loadGraphJson(workspaceRoot: string): Promise<GraphifyJson | null> {
  const p = graphOutPath(workspaceRoot);
  try {
    const stat = await fs.promises.stat(p);
    if (stat.size > MAX_GRAPH_JSON_BYTES) {
      console.warn(`[Docs Agent] graph.json is ${stat.size} bytes — exceeds 50 MB limit, skipping`);
      return null;
    }
    const raw = JSON.parse(await fs.promises.readFile(p, 'utf8'));
    if (!raw || !Array.isArray(raw.nodes)) {
      console.warn('[Docs Agent] graph.json: "nodes" is not an array — skipping');
      return null;
    }
    return raw as GraphifyJson;
  } catch {
    return null;
  }
}

// ── File watcher ──────────────────────────────────────────────────────────────

export function watchGraphJson(workspaceRoot: string, onChange: () => void): vscode.Disposable {
  const dir = path.join(workspaceRoot, GRAPHIFY_OUT_DIR);
  if (!fs.existsSync(dir)) return { dispose: () => {} };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;

  try {
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== GRAPH_JSON_FILE) return;
      // Debounce: graphify may flush graph.json in multiple writes.
      clearTimeout(timer);
      timer = setTimeout(onChange, 600);
    });
  } catch {
    // Non-fatal — watch may fail on network drives or certain Linux kernels.
  }

  return {
    dispose() {
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
