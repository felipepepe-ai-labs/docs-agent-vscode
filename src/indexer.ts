import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph, SqlOperation } from './graph';

export function buildGraph(workspaceRoot: string): CodeGraph {
  const graph = new CodeGraph();
  for (const file of collectSourceFiles(workspaceRoot)) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) { console.warn('[Docs Agent] Cannot read file:', file, err); continue; }
    try {
      if (file.endsWith('.java')) parseJava(file, content, graph);
      else parseCSharp(file, content, graph);
    } catch (err) {
      console.error(`[Docs Agent] Parse failed: ${file}`, err);
    }
  }
  return graph;
}

function collectSourceFiles(root: string): string[] {
  const results: string[] = [];
  const SKIP = new Set(['.git', 'node_modules', 'target', 'bin', 'obj', '.gradle', 'build', 'out', '.idea', '.vs']);

  function scan(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { console.warn('[Docs Agent] Cannot scan dir:', dir, err); return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full);
      else if (e.name.endsWith('.java') || e.name.endsWith('.cs')) results.push(full);
    }
  }

  scan(root);
  return results;
}

function sqlOp(sql: string): SqlOperation {
  const u = sql.trimStart().toUpperCase();
  if (u.startsWith('SELECT')) return 'SELECT';
  if (u.startsWith('INSERT')) return 'INSERT';
  if (u.startsWith('UPDATE')) return 'UPDATE';
  if (u.startsWith('DELETE')) return 'DELETE';
  if (u.startsWith('MERGE')) return 'MERGE';
  return 'unknown';
}

// Extracts table names from SQL string literals on a single source line.
function extractTableRefs(line: string): { table: string; operation: SqlOperation }[] {
  const result: { table: string; operation: SqlOperation }[] = [];
  const strRx = /"([^"]+)"|'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = strRx.exec(line)) !== null) {
    const sql = m[1] ?? m[2];
    const tblRx = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/gi;
    let t: RegExpExecArray | null;
    while ((t = tblRx.exec(sql)) !== null) {
      result.push({ table: t[1], operation: sqlOp(sql) });
    }
  }
  return result;
}

interface ParseState {
  braceDepth: number;
  classBraceDepth: number;
  methodBraceDepth: number;
  currentClass: string;
  currentMethod: string;
}

function advanceBraces(line: string, s: ParseState): void {
  const opens = (line.match(/\{/g) ?? []).length;
  const closes = (line.match(/\}/g) ?? []).length;
  s.braceDepth += opens - closes;

  if (s.methodBraceDepth >= 0 && s.braceDepth <= s.methodBraceDepth) {
    s.currentMethod = '';
    s.methodBraceDepth = -1;
  }
  if (s.classBraceDepth >= 0 && s.braceDepth <= s.classBraceDepth) {
    s.currentClass = '';
    s.currentMethod = '';
    s.classBraceDepth = -1;
    s.methodBraceDepth = -1;
  }
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_CALL_SKIP = new Set(['System', 'String', 'Math', 'Arrays', 'Collections', 'Objects', 'Optional', 'log', 'logger', 'LOGGER', 'LOG']);
const JAVA_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'try', 'else', 'finally', 'do', 'synchronized']);

function parseJava(file: string, content: string, graph: CodeGraph): void {
  const lines = content.split('\n');
  const s: ParseState = { braceDepth: 0, classBraceDepth: -1, methodBraceDepth: -1, currentClass: '', currentMethod: '' };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    const atClassBody = s.currentClass !== '' && s.braceDepth === s.classBraceDepth + 1;
    const atTopLevel = s.currentClass === '' && s.classBraceDepth === -1;

    // Class / enum declaration
    if (atTopLevel || atClassBody) {
      const cm = /(?:public|protected|private)?\s*(?:abstract|final|static)?\s*(?:class|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s<>]+?))?(?:\s*\{|$)/.exec(line);
      if (cm) {
        s.currentClass = cm[1];
        graph.addNode({ symbol: s.currentClass, file, line: ln, kind: 'class' });
        s.classBraceDepth = s.braceDepth;
        if (cm[2]) graph.addImplementsEdge({ implementor: s.currentClass, contract: cm[2] });
        if (cm[3]) {
          for (const c of cm[3].split(',')) {
            const clean = c.trim().replace(/<[^>]+>/g, '');
            if (clean) graph.addImplementsEdge({ implementor: s.currentClass, contract: clean });
          }
        }
      }
      // Interface declaration
      const im = /(?:public|protected|private)?\s*interface\s+(\w+)/.exec(line);
      if (im && !cm) {
        s.currentClass = im[1];
        graph.addNode({ symbol: s.currentClass, file, line: ln, kind: 'interface' });
        s.classBraceDepth = s.braceDepth;
      }
    }

    // Field at class body level (only when not inside a method)
    if (atClassBody && !s.currentMethod) {
      const fm = /^\s+(?:@\w+\s+)*(?:private|protected|public)\s+(?:(?:final|static)\s+)*(\w+)\s+(\w+)\s*(?:=|;)/.exec(line);
      if (fm && /^[A-Z]/.test(fm[1]) && !JAVA_CALL_SKIP.has(fm[1])) {
        graph.addInjectsEdge({ consumer: s.currentClass, dependency: fm[1], fieldName: fm[2] });
      }
    }

    // Method / constructor at class body level
    if (atClassBody && !s.currentMethod) {
      const mm = /^\s+(?:@\w+\s+)*(?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)*(?:<[\w,\s]+>\s+)?[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)(?:\s+throws\s+[\w,\s]+)?\s*\{/.exec(line);
      if (mm && !JAVA_KW.has(mm[1])) {
        s.currentMethod = `${s.currentClass}.${mm[1]}`;
        graph.addNode({ symbol: s.currentMethod, file, line: ln, kind: 'method' });
        s.methodBraceDepth = s.braceDepth;
      }
      const ctm = /^\s+(?:public|protected|private)\s+(\w+)\s*\([^)]*\)(?:\s+throws\s+[\w,\s]+)?\s*\{/.exec(line);
      if (ctm && ctm[1] === s.currentClass && !s.currentMethod) {
        s.currentMethod = `${s.currentClass}.<init>`;
        graph.addNode({ symbol: s.currentMethod, file, line: ln, kind: 'constructor' });
        s.methodBraceDepth = s.braceDepth;
      }
    }

    // Inside method body
    if (s.currentMethod && s.braceDepth > s.methodBraceDepth) {
      const callRx = /(\w+)\.(\w+)\s*\(/g;
      let callM: RegExpExecArray | null;
      while ((callM = callRx.exec(line)) !== null) {
        if (!JAVA_CALL_SKIP.has(callM[1]) && !JAVA_KW.has(callM[2])) {
          graph.addCallEdge({ caller: s.currentMethod, callerFile: file, callerLine: ln, callee: callM[2] });
        }
      }
      for (const ref of extractTableRefs(line)) {
        graph.addTableEdge({ symbol: s.currentMethod, file, line: ln, ...ref });
      }
    }

    // @Query annotations carry SQL even when outside a method body
    if (s.currentClass && /^\s*@Query/.test(line)) {
      for (const ref of extractTableRefs(line)) {
        graph.addTableEdge({ symbol: s.currentClass, file, line: ln, ...ref });
      }
    }

    advanceBraces(line, s);
  }
}

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

const CS_CALL_SKIP = new Set(['Console', 'String', 'Math', 'Convert', 'DateTime', 'Debug', 'Trace', 'Response', 'Request', 'Server', 'Session', 'Application', 'ScriptManager', 'ViewState', 'base', 'this']);
const CS_KW = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'try', 'else', 'finally', 'do', 'lock', 'using']);

function parseCSharp(file: string, content: string, graph: CodeGraph): void {
  const lines = content.split('\n');
  const s: ParseState = { braceDepth: 0, classBraceDepth: -1, methodBraceDepth: -1, currentClass: '', currentMethod: '' };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    const atClassBody = s.currentClass !== '' && s.braceDepth === s.classBraceDepth + 1;
    const atTopLevel = s.currentClass === '' && s.classBraceDepth === -1;

    // Class / struct declaration
    if (atTopLevel || atClassBody) {
      const cm = /(?:public|protected|private|internal)?\s*(?:partial|abstract|sealed|static)?\s*(?:class|struct)\s+(\w+)(?:\s*:\s*([\w,\s<>.]+?))?(?:\s*\{|$)/.exec(line);
      if (cm) {
        s.currentClass = cm[1];
        graph.addNode({ symbol: s.currentClass, file, line: ln, kind: 'class' });
        s.classBraceDepth = s.braceDepth;
        if (cm[2]) {
          for (const c of cm[2].split(',')) {
            const clean = c.trim().replace(/<[^>]+>/g, '').replace(/.*\./g, '');
            if (clean && /^[A-Z]/.test(clean)) {
              graph.addImplementsEdge({ implementor: s.currentClass, contract: clean });
            }
          }
        }
      }
      // Interface declaration
      const im = /(?:public|protected|private|internal)?\s*interface\s+(\w+)/.exec(line);
      if (im && !cm) {
        s.currentClass = im[1];
        graph.addNode({ symbol: s.currentClass, file, line: ln, kind: 'interface' });
        s.classBraceDepth = s.braceDepth;
      }
    }

    // Field at class body level
    if (atClassBody && !s.currentMethod) {
      const fm = /^\s+(?:private|protected|public|internal)\s+(?:readonly\s+)?(?:static\s+)?(\w+)\s+(\w+)\s*(?:=|;)/.exec(line);
      if (fm && /^[A-Z]/.test(fm[1]) && !CS_CALL_SKIP.has(fm[1])) {
        graph.addInjectsEdge({ consumer: s.currentClass, dependency: fm[1], fieldName: fm[2] });
      }
    }

    // Method / constructor at class body level
    if (atClassBody && !s.currentMethod) {
      const mm = /^\s+(?:(?:public|protected|private|internal|static|virtual|override|abstract|async|sealed|new)\s+)*(?:Task(?:<[\w<>?]+>)?|void|[\w<>\[\]?]+)\s+(\w+)\s*\([^)]*\)(?:\s*where\s+\w+\s*:\s*[\w,\s]+)?\s*\{/.exec(line);
      if (mm && !CS_KW.has(mm[1])) {
        s.currentMethod = `${s.currentClass}.${mm[1]}`;
        graph.addNode({ symbol: s.currentMethod, file, line: ln, kind: 'method' });
        s.methodBraceDepth = s.braceDepth;
      }
      const ctm = /^\s+(?:public|protected|private|internal)\s+(\w+)\s*\([^)]*\)(?:\s*:\s*(?:base|this)\s*\([^)]*\))?\s*\{/.exec(line);
      if (ctm && ctm[1] === s.currentClass && !s.currentMethod) {
        s.currentMethod = `${s.currentClass}.<init>`;
        graph.addNode({ symbol: s.currentMethod, file, line: ln, kind: 'constructor' });
        s.methodBraceDepth = s.braceDepth;
      }
    }

    // Inside method body
    if (s.currentMethod && s.braceDepth > s.methodBraceDepth) {
      const callRx = /(\w+)\.(\w+)\s*\(/g;
      let callM: RegExpExecArray | null;
      while ((callM = callRx.exec(line)) !== null) {
        if (!CS_CALL_SKIP.has(callM[1]) && !CS_KW.has(callM[2])) {
          graph.addCallEdge({ caller: s.currentMethod, callerFile: file, callerLine: ln, callee: callM[2] });
        }
      }
      for (const ref of extractTableRefs(line)) {
        graph.addTableEdge({ symbol: s.currentMethod, file, line: ln, ...ref });
      }
    }

    advanceBraces(line, s);
  }
}
