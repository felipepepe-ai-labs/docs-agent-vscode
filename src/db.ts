import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { CallEdge, CodeGraph, ImplementsEdge, InjectsEdge, SymbolNode, TableEdge } from './graph';

const MAX_SNAPSHOTS = 10;

let db: DatabaseSync | null = null;

export function initDb(storagePath: string): void {
  fs.mkdirSync(storagePath, { recursive: true });
  db = new DatabaseSync(path.join(storagePath, 'graph.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      root_path   TEXT    UNIQUE NOT NULL,
      last_indexed INTEGER
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nodes (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol      TEXT NOT NULL,
      file        TEXT NOT NULL,
      line        INTEGER NOT NULL,
      kind        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS call_edges (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      caller      TEXT NOT NULL,
      caller_file TEXT NOT NULL,
      caller_line INTEGER NOT NULL,
      callee      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS table_edges (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol      TEXT NOT NULL,
      file        TEXT NOT NULL,
      line        INTEGER NOT NULL,
      table_name  TEXT NOT NULL,
      operation   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS implements_edges (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      implementor TEXT NOT NULL,
      contract    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS injects_edges (
      snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      consumer     TEXT NOT NULL,
      dependency   TEXT NOT NULL,
      field_name   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_snap      ON nodes(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_call_snap       ON call_edges(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_table_snap      ON table_edges(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_impl_snap       ON implements_edges(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_inj_snap        ON injects_edges(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_snap_workspace  ON snapshots(workspace_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      symbol, file, kind,
      content='nodes',
      content_rowid='rowid',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, symbol, file, kind)
        VALUES (new.rowid, new.symbol, new.file, new.kind);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, symbol, file, kind)
        VALUES ('delete', old.rowid, old.symbol, old.file, old.kind);
    END;
  `);
}

function runTransaction(fn: () => void): void {
  db!.exec('BEGIN');
  try {
    fn();
    db!.exec('COMMIT');
  } catch (err) {
    try { db!.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function saveGraph(workspaceRoot: string, graph: CodeGraph): void {
  if (!db) { console.error('[Docs Agent] DB not initialized — graph will not be cached'); return; }
  const now = Date.now();

  db.prepare('INSERT OR IGNORE INTO workspaces (root_path) VALUES (?)').run(workspaceRoot);
  db.prepare('UPDATE workspaces SET last_indexed = ? WHERE root_path = ?').run(now, workspaceRoot);
  const ws = db.prepare('SELECT id FROM workspaces WHERE root_path = ?').get(workspaceRoot) as { id: number };

  runTransaction(() => {
    const snapId = Number(db!.prepare('INSERT INTO snapshots (workspace_id, created_at) VALUES (?, ?)').run(ws.id, now).lastInsertRowid);

    const insNode = db!.prepare('INSERT INTO nodes (snapshot_id,symbol,file,line,kind) VALUES (?,?,?,?,?)');
    for (const n of graph.nodes.values()) insNode.run(snapId, n.symbol, n.file, n.line, n.kind);

    const insCall = db!.prepare('INSERT INTO call_edges (snapshot_id,caller,caller_file,caller_line,callee) VALUES (?,?,?,?,?)');
    for (const e of graph.callEdges) insCall.run(snapId, e.caller, e.callerFile, e.callerLine, e.callee);

    const insTable = db!.prepare('INSERT INTO table_edges (snapshot_id,symbol,file,line,table_name,operation) VALUES (?,?,?,?,?,?)');
    for (const e of graph.tableEdges) insTable.run(snapId, e.symbol, e.file, e.line, e.table, e.operation);

    const insImpl = db!.prepare('INSERT INTO implements_edges (snapshot_id,implementor,contract) VALUES (?,?,?)');
    for (const e of graph.implementsEdges) insImpl.run(snapId, e.implementor, e.contract);

    const insInj = db!.prepare('INSERT INTO injects_edges (snapshot_id,consumer,dependency,field_name) VALUES (?,?,?,?)');
    for (const e of graph.injectsEdges) insInj.run(snapId, e.consumer, e.dependency, e.fieldName);

    const pruneIds = (db!.prepare(
      'SELECT id FROM snapshots WHERE workspace_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?'
    ).all(ws.id, MAX_SNAPSHOTS) as { id: number }[]).map(r => r.id);

    for (const pruneId of pruneIds) {
      db!.prepare('DELETE FROM snapshots WHERE id = ?').run(pruneId);
    }
  });
}

export function loadGraph(workspaceRoot: string): CodeGraph | null {
  if (!db) return null;
  const ws = db.prepare('SELECT id FROM workspaces WHERE root_path = ?').get(workspaceRoot) as { id: number } | undefined;
  if (!ws) return null;

  const snap = db.prepare(
    'SELECT id FROM snapshots WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(ws.id) as { id: number } | undefined;
  if (!snap) return null;

  const graph = new CodeGraph();

  for (const n of db.prepare('SELECT symbol,file,line,kind FROM nodes WHERE snapshot_id=?').all(snap.id) as SymbolNode[]) {
    graph.addNode(n);
  }
  for (const e of db.prepare('SELECT caller,caller_file AS callerFile,caller_line AS callerLine,callee FROM call_edges WHERE snapshot_id=?').all(snap.id) as CallEdge[]) {
    graph.addCallEdge(e);
  }
  for (const e of db.prepare('SELECT symbol,file,line,table_name AS "table",operation FROM table_edges WHERE snapshot_id=?').all(snap.id) as TableEdge[]) {
    graph.addTableEdge(e);
  }
  for (const e of db.prepare('SELECT implementor,contract FROM implements_edges WHERE snapshot_id=?').all(snap.id) as ImplementsEdge[]) {
    graph.addImplementsEdge(e);
  }
  for (const e of db.prepare('SELECT consumer,dependency,field_name AS fieldName FROM injects_edges WHERE snapshot_id=?').all(snap.id) as InjectsEdge[]) {
    graph.addInjectsEdge(e);
  }

  return graph;
}

/** Full-text search across all indexed workspaces using FTS5 trigram index. */
export function searchNodes(
  query: string,
  opts: { workspaceRoot?: string; kind?: string; limit?: number } = {}
): { symbol: string; file: string; line: number; kind: string; workspaceRoot: string }[] {
  if (!db || !query.trim()) return [];
  const { workspaceRoot, kind, limit = 50 } = opts;

  const conditions: string[] = ['nodes_fts MATCH ?'];
  const params: unknown[] = [query];

  if (workspaceRoot) {
    conditions.push('w.root_path = ?');
    params.push(workspaceRoot);
  }
  if (kind) {
    conditions.push('n.kind = ?');
    params.push(kind);
  }
  params.push(limit);

  return db.prepare(`
    SELECT n.symbol, n.file, n.line, n.kind, w.root_path AS workspaceRoot
    FROM nodes_fts
    JOIN nodes n ON n.rowid = nodes_fts.rowid
    JOIN snapshots s ON s.id = n.snapshot_id
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank
    LIMIT ?
  `).all(...params as Parameters<typeof db.prepare>) as { symbol: string; file: string; line: number; kind: string; workspaceRoot: string }[];
}

export function listWorkspaces(): { rootPath: string; lastIndexed: number; snapshotCount: number }[] {
  if (!db) return [];
  return (db.prepare(`
    SELECT w.root_path AS rootPath, w.last_indexed AS lastIndexed,
           COUNT(s.id) AS snapshotCount
    FROM workspaces w
    LEFT JOIN snapshots s ON s.workspace_id = w.id
    GROUP BY w.id
    ORDER BY w.last_indexed DESC
  `).all() as { rootPath: string; lastIndexed: number; snapshotCount: number }[]);
}
