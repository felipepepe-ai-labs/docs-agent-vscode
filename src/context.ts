import * as fs from 'fs';
import * as path from 'path';
import { fromCbmRelativePath, toCbmRelativePath, type CbmManager } from './cbm-runner';
import { CBM_CALLER_LABELS } from './graph';

export interface FileContext {
  primary: { filePath: string; content: string };
  dependencies: { filePath: string; content: string }[];
}

export function buildContext(activeFilePath: string, workspaceRoot: string): FileContext {
  let realPath: string;
  try {
    realPath = fs.realpathSync(activeFilePath);
  } catch (err) {
    throw new Error(`Cannot resolve path "${activeFilePath}": ${(err as Error).message}`);
  }
  const sep = path.sep;
  if (realPath !== workspaceRoot && !realPath.startsWith(workspaceRoot + sep)) {
    throw new Error(`File resolves outside the workspace: ${activeFilePath}`);
  }

  let primaryContent: string;
  try {
    primaryContent = fs.readFileSync(realPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read file "${activeFilePath}": ${(err as Error).message}`);
  }
  const dependencies = resolveDependencies(activeFilePath, primaryContent, workspaceRoot);
  return { primary: { filePath: activeFilePath, content: primaryContent }, dependencies };
}

export function buildContextFiles(ctx: FileContext): Set<string> {
  const files = new Set<string>([ctx.primary.filePath]);
  for (const dep of ctx.dependencies) files.add(dep.filePath);
  return files;
}

function resolveDependencies(
  filePath: string,
  content: string,
  workspaceRoot: string
): { filePath: string; content: string }[] {
  const deps: { filePath: string; content: string }[] = [];
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath, path.extname(filePath));

  // For *Impl.java → look for the interface in the same package
  if (fileName.endsWith('Impl')) {
    const interfaceName = fileName.replace(/Impl$/, '');
    const interfacePath = path.join(fileDir, `${interfaceName}.java`);
    if (fs.existsSync(interfacePath)) {
      try {
        deps.push({ filePath: interfacePath, content: fs.readFileSync(interfacePath, 'utf8') });
      } catch (err) { console.warn('[Docs Agent] Cannot read dependency:', interfacePath, err); }
    }
  }

  // Resolve same-project imports (DTOs, enums, models)
  const importPattern = /import\s+(com\.example\.\S+);/g;
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(content)) !== null) {
    const fqn = match[1];
    const relativePath = fqn.replace(/\./g, '/') + '.java';
    const candidate = path.join(workspaceRoot, 'src/main/java', relativePath);

    if (fs.existsSync(candidate) && candidate !== filePath && !deps.find(d => d.filePath === candidate)) {
      try {
        deps.push({ filePath: candidate, content: fs.readFileSync(candidate, 'utf8') });
      } catch (err) { console.warn('[Docs Agent] Cannot read dependency:', candidate, err); }
    }
  }

  return deps;
}

function formatSection(filePath: string, content: string): string {
  // Escape closing tags so injected content cannot break out of the source_code boundary
  const safe = content.replace(/<\/source_code>/gi, '<\\/source_code>');
  return `// FILE: ${filePath}\n<source_code>\n${safe}\n</source_code>`;
}

// Enriched context using codebase-memory-mcp:
// - Queries the call graph for outbound dependencies of the active file
// - Fetches precise symbol snippets instead of reading whole files
// - Falls back to base buildContext for files not yet in the graph
export async function buildContextWithCbm(
  activeFilePath: string,
  workspaceRoot:  string,
  cbm:            CbmManager,
): Promise<FileContext> {
  const base = buildContext(activeFilePath, workspaceRoot);

  // CBM's file_path is relative to workspaceRoot (e.g. "src/context.ts"), never
  // the absolute paths used everywhere else in this extension — every query and
  // result below converts through toCbmRelativePath/fromCbmRelativePath.
  const relActivePath = toCbmRelativePath(activeFilePath, workspaceRoot);
  const safePath = relActivePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Cypher: find symbols in other files that callers in activeFilePath call
  let depQns: { qn: string; file: string }[] = [];
  try {
    const { rows } = await cbm.queryGraph(
      `MATCH (caller:${CBM_CALLER_LABELS})-[:CALLS]->(callee) ` +
      `WHERE caller.file_path = '${safePath}' ` +
      `AND callee.file_path IS NOT NULL AND callee.file_path <> '${safePath}' ` +
      `RETURN DISTINCT callee.qualified_name AS qn, callee.file_path AS file LIMIT 15`,
    );
    depQns = rows as { qn: string; file: string }[];
  } catch { /* graph not ready or query unsupported — use base context */ }

  const seen = new Set<string>([
    activeFilePath,
    ...base.dependencies.map(d => d.filePath),
  ]);
  const extraDeps: { filePath: string; content: string }[] = [];

  for (const { qn, file: relFile } of depQns) {
    if (!relFile || !qn) continue;
    const file = fromCbmRelativePath(relFile, workspaceRoot);
    if (seen.has(file)) continue;
    // Strict workspace containment — never fetch files outside the root
    if (!file.startsWith(workspaceRoot + path.sep) && file !== workspaceRoot) continue;
    try {
      const snippet = await cbm.getCodeSnippet(qn);
      if (snippet) {
        extraDeps.push({ filePath: file, content: snippet });
        seen.add(file);
      }
    } catch { /* symbol not indexed or ambiguous — skip */ }
  }

  // IMPLEMENTS: language-agnostic replacement for the Java-only `*Impl` filename
  // heuristic in resolveDependencies() — CALLS alone never surfaces an
  // interface/implementation pair since implementing an interface isn't a call.
  let implRows: { a_qn: string; a_file: string; b_qn: string; b_file: string }[] = [];
  try {
    const { rows } = await cbm.queryGraph(
      `MATCH (a)-[:IMPLEMENTS]->(b) WHERE a.file_path = '${safePath}' OR b.file_path = '${safePath}' ` +
      'RETURN a.qualified_name AS a_qn, a.file_path AS a_file, b.qualified_name AS b_qn, b.file_path AS b_file LIMIT 15',
    );
    implRows = rows as { a_qn: string; a_file: string; b_qn: string; b_file: string }[];
  } catch { /* IMPLEMENTS not available — skip */ }

  for (const row of implRows) {
    const [qn, relFile] = row.a_file === relActivePath ? [row.b_qn, row.b_file] : [row.a_qn, row.a_file];
    if (!relFile || !qn) continue;
    const file = fromCbmRelativePath(relFile, workspaceRoot);
    if (seen.has(file)) continue;
    if (!file.startsWith(workspaceRoot + path.sep) && file !== workspaceRoot) continue;
    try {
      const snippet = await cbm.getCodeSnippet(qn);
      if (snippet) {
        extraDeps.push({ filePath: file, content: snippet });
        seen.add(file);
      }
    } catch { /* symbol not indexed or ambiguous — skip */ }
  }

  return {
    primary:      base.primary,
    dependencies: [...base.dependencies, ...extraDeps],
  };
}

export function formatContextBundle(ctx: FileContext): string {
  const sections: string[] = [];

  sections.push(formatSection(ctx.primary.filePath, ctx.primary.content));

  for (const dep of ctx.dependencies) {
    sections.push(formatSection(dep.filePath, dep.content));
  }

  return sections.join('\n\n// ---\n\n');
}
