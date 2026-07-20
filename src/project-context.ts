import * as fs from 'fs';
import * as path from 'path';
import { fromCbmRelativePath, type CbmManager } from './cbm-runner';

export interface FileSnippet { path: string; content: string }

export interface ProjectContext {
  name:         string;
  type:         string;   // 'spring-boot' | 'dotnet-webforms' | 'node' | 'unknown'
  structure:    string;   // directory tree string
  manifest:     string;   // pom.xml / package.json / .csproj
  existingDocs: string;   // existing README / docs content
  sourceFiles:  FileSnippet[];
}

// ── Public entry point ────────────────────────────────────────────────────────
export async function buildProjectContext(root: string, cbm?: CbmManager): Promise<ProjectContext> {
  const manifest     = readManifest(root);
  const type         = detectType(root, manifest);
  const name         = detectName(root, manifest);
  const structure    = buildTree(root, 0, 3);
  const existingDocs = readExistingDocs(root);
  const fileDegrees  = cbm ? await computeFileDegrees(cbm, root) : new Map<string, number>();
  const sourceFiles  = sampleSourceFiles(root, type, 60_000, fileDegrees);

  return { name, type, structure, manifest, existingDocs, sourceFiles };
}

// Ranks files by call-graph degree (fan-in + fan-out) so file selection reflects
// actual code structure instead of only filename conventions. Falls back to an
// empty map (pure regex ranking) when CBM is unavailable or the query fails.
async function computeFileDegrees(cbm: CbmManager, root: string): Promise<Map<string, number>> {
  const degrees = new Map<string, number>();
  try {
    const { rows } = await cbm.queryGraph(
      'MATCH (a)-[:CALLS]->(b) WHERE a.file_path IS NOT NULL AND b.file_path IS NOT NULL ' +
      'RETURN a.file_path AS caller, b.file_path AS callee LIMIT 5000',
    );
    // CBM returns file_path relative to the repo root — convert to the absolute
    // paths collectFiles()/sampleSourceFiles() work with, or the join is a no-op.
    for (const row of rows as { caller: string; callee: string }[]) {
      if (row.caller) {
        const abs = fromCbmRelativePath(row.caller, root);
        degrees.set(abs, (degrees.get(abs) ?? 0) + 1);
      }
      if (row.callee) {
        const abs = fromCbmRelativePath(row.callee, root);
        degrees.set(abs, (degrees.get(abs) ?? 0) + 1);
      }
    }
  } catch { /* CBM not ready — degrees stays empty, sampleSourceFiles falls back to regex-only ranking */ }
  return degrees;
}

// ── Project type detection ────────────────────────────────────────────────────
function detectType(root: string, manifest: string): string {
  if (fs.existsSync(path.join(root, 'pom.xml'))) {
    return manifest.includes('spring-boot') ? 'spring-boot' : 'java-maven';
  }
  if (fs.existsSync(path.join(root, 'build.gradle'))) return 'java-gradle';
  const csproj = findFirst(root, '.csproj');
  if (csproj) {
    return manifest.includes('WebForms') || manifest.includes('System.Web') ? 'dotnet-webforms' : 'dotnet';
  }
  if (fs.existsSync(path.join(root, 'package.json'))) {
    const pkg = safeRead(path.join(root, 'package.json'));
    if (pkg.includes('"@angular/core"'))                                              return 'angular';
    if (pkg.includes('"express"') || pkg.includes('"fastify"') || pkg.includes('"koa"')) return 'node-api';
    if (pkg.includes('"react"') || pkg.includes('"next"') || pkg.includes('"vue"')) return 'node-frontend';
    return 'node';
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return 'rust';
  if (fs.existsSync(path.join(root, 'go.mod')))     return 'go';
  return 'unknown';
}

function detectName(root: string, manifest: string): string {
  // package.json
  try {
    const pkg = JSON.parse(manifest);
    if (pkg.name) return pkg.name;
    if (pkg.displayName) return pkg.displayName;
  } catch { /* not JSON */ }
  // pom.xml — look for <artifactId>
  const artId = /<artifactId>([^<]+)<\/artifactId>/.exec(manifest)?.[1];
  if (artId) return artId;
  // .csproj — look for <AssemblyName>
  const asm = /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(manifest)?.[1];
  if (asm) return asm;
  return path.basename(root);
}

// ── Manifest reader ───────────────────────────────────────────────────────────
function readManifest(root: string): string {
  const candidates = ['package.json', 'pom.xml', 'build.gradle', 'go.mod', 'Cargo.toml'];
  for (const f of candidates) {
    const full = path.join(root, f);
    if (fs.existsSync(full)) return safeRead(full);
  }
  const csproj = findFirst(root, '.csproj');
  if (csproj) return safeRead(csproj);
  return '';
}

// ── Directory tree ────────────────────────────────────────────────────────────
const SKIP_DIRS  = new Set(['.git', 'node_modules', 'target', 'bin', 'obj', '.gradle',
                             'build', 'dist', 'out', '.idea', '.vs', '__pycache__', '.next']);
const SKIP_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.woff',
                             '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.gz', '.lock']);

function buildTree(dir: string, depth: number, maxDepth: number): string {
  if (depth > maxDepth) return '';
  const lines: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }

  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const e of sorted) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const indent = '  '.repeat(depth);
    if (e.isDirectory()) {
      lines.push(`${indent}${e.name}/`);
      const sub = buildTree(path.join(dir, e.name), depth + 1, maxDepth);
      if (sub) lines.push(sub);
    } else {
      if (SKIP_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      lines.push(`${indent}${e.name}`);
    }
  }
  return lines.join('\n');
}

// ── Existing docs ─────────────────────────────────────────────────────────────
function readExistingDocs(root: string): string {
  const parts: string[] = [];
  const candidates = ['README.md', 'README.txt', 'ARCHITECTURE.md', 'docs/README.md'];
  for (const f of candidates) {
    const full = path.join(root, f);
    if (fs.existsSync(full)) {
      parts.push(`// FILE: ${f}\n${safeRead(full).slice(0, 4000)}`);
    }
  }
  return parts.join('\n\n');
}

// ── Source file sampling ──────────────────────────────────────────────────────
const SOURCE_EXTS = new Set(['.java', '.cs', '.ts', '.js', '.py', '.go', '.rs',
                              '.kt', '.scala', '.rb', '.php', '.xml', '.json', '.yaml', '.yml']);

function scoreFile(filePath: string): number {
  const name  = path.basename(filePath).toLowerCase();
  const noExt = name.replace(/\.[^.]+$/, '');

  // Deprioritize test and generated files
  if (/test|spec|mock|fixture|migration|generated|g\.cs/.test(name)) return -1;
  if (name.endsWith('.d.ts') || name.endsWith('.stories.ts'))         return -1;

  // High-value patterns (Java/C# + Angular combined)
  if (/controller|page|handler|endpoint|router|route|component/.test(noExt)) return 10;
  if (/service|business|bll|usecase|interactor/.test(noExt))                 return 8;
  if (/interface|iservice|irepository|contract|guard|resolver/.test(noExt))  return 7;
  if (/repository|dal|dataaccess|store|reducer|effect|facade/.test(noExt))   return 6;
  if (/model|entity|dto|domain|schema/.test(noExt))                          return 5;
  if (/config|settings|startup|program|main|app|routes|routing/.test(noExt)) return 4;
  if (/global|filter|middleware|pipeline|interceptor|pipe|directive/.test(noExt)) return 3;

  return 1;
}

function sampleSourceFiles(
  root: string,
  _type: string,
  charBudget: number,
  fileDegrees: Map<string, number> = new Map(),
): FileSnippet[] {
  const all = collectFiles(root);
  const scored = all
    .filter(f => SOURCE_EXTS.has(path.extname(f).toLowerCase()))
    .map(f  => ({ path: f, score: scoreFile(f), degree: fileDegrees.get(f) ?? 0 }))
    .filter(x => x.score >= 0)
    .sort((a, b) => fileDegrees.size > 0 ? (b.degree - a.degree) || (b.score - a.score) : b.score - a.score);

  const result: FileSnippet[] = [];
  let used = 0;

  for (const { path: fp } of scored) {
    if (used >= charBudget) break;
    const content = safeRead(fp);
    if (!content) continue;
    const relPath = path.relative(root, fp).replace(/\\/g, '/');
    const snippet = content.slice(0, Math.min(content.length, 3000)); // cap per file
    result.push({ path: relPath, content: snippet });
    used += snippet.length;
  }

  return result;
}

function collectFiles(root: string): string[] {
  const results: string[] = [];
  function scan(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { console.warn('[Docs Agent] Cannot scan dir:', dir, err); return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full);
      else results.push(full);
    }
  }
  scan(root);
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeRead(fp: string): string {
  try { return fs.readFileSync(fp, 'utf8'); } catch (err) { console.warn('[Docs Agent] Cannot read:', fp, err); return ''; }
}

function findFirst(root: string, ext: string): string | null {
  const files = collectFiles(root);
  return files.find(f => f.endsWith(ext)) ?? null;
}
