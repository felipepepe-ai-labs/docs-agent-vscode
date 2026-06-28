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
    const args = update ? ['update', '.'] : ['.'];
    const proc = cp.spawn('graphify', args, {
      cwd:   workspaceRoot,
      shell: true,                    // resolves PATH from user shell (uv/pip installs)
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

// ── graph.json I/O ────────────────────────────────────────────────────────────

export function loadGraphJson(workspaceRoot: string): GraphifyJson | null {
  try {
    return JSON.parse(fs.readFileSync(graphOutPath(workspaceRoot), 'utf8')) as GraphifyJson;
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
