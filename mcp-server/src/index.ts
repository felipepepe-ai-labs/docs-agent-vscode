import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// DB path resolution
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  const envPath = process.env.GRAPH_DB_PATH;
  if (envPath) return envPath;

  // Auto-detect VS Code globalStorage location
  const platform = process.platform;
  let base: string;
  if (platform === "win32") {
    base = path.join(process.env.APPDATA ?? os.homedir(), "Code", "User", "globalStorage");
  } else if (platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage");
  } else {
    base = path.join(os.homedir(), ".config", "Code", "User", "globalStorage");
  }
  return path.join(base, "felipepepe.docs-agent", "graph.db");
}

const dbPath = resolveDbPath();

if (!fs.existsSync(dbPath)) {
  process.stderr.write(
    `[code-graph] DB not found at ${dbPath}.\n` +
    `Open VS Code with the Docs Agent extension active to index your workspace first.\n` +
    `Or set GRAPH_DB_PATH env var to the correct path.\n`
  );
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SnapContext {
  snapId: number;
  workspaceRoot: string;
}

function getLatestSnapshot(workspaceRoot?: string): SnapContext | null {
  if (workspaceRoot) {
    const ws = db
      .prepare("SELECT id FROM workspaces WHERE root_path = ?")
      .get(workspaceRoot) as { id: number } | undefined;
    if (!ws) return null;
    const snap = db
      .prepare("SELECT id FROM snapshots WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(ws.id) as { id: number } | undefined;
    if (!snap) return null;
    return { snapId: snap.id, workspaceRoot };
  }

  const row = db
    .prepare(
      `SELECT s.id AS snapId, w.root_path AS workspaceRoot
       FROM snapshots s
       JOIN workspaces w ON w.id = s.workspace_id
       ORDER BY s.created_at DESC LIMIT 1`
    )
    .get() as SnapContext | undefined;
  return row ?? null;
}

const NO_INDEX_MSG =
  "No indexed workspace found. Open VS Code with the Docs Agent extension to index your code first.";

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "code-graph", version: "1.0.0" });

// ── graph_search ────────────────────────────────────────────────────────────

server.registerTool(
  "graph_search",
  {
    description:
      "Fuzzy-search symbols (classes, methods, fields, interfaces) in the indexed codebase. " +
      "Returns file path and line number for each match. Use this first to locate a symbol " +
      "before running impact, callers, or dependency queries.",
    inputSchema: {
      query: z.string().describe("Symbol name or partial name to search for"),
      workspace: z
        .string()
        .optional()
        .describe("Filter to a specific workspace root path. Omit to search all indexed workspaces."),
      kind: z
        .enum(["class", "interface", "method", "constructor", "field"])
        .optional()
        .describe("Filter by symbol kind"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(30)
        .describe("Max results to return (default: 30)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, workspace, kind, limit }) => {
    if (!query.trim()) {
      return { content: [{ type: "text", text: "Query cannot be empty." }] };
    }

    const conditions = ["nodes_fts MATCH ?"];
    const params: unknown[] = [query];

    if (workspace) {
      conditions.push("w.root_path = ?");
      params.push(workspace);
    }
    if (kind) {
      conditions.push("n.kind = ?");
      params.push(kind);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT n.symbol, n.file, n.line, n.kind, w.root_path AS workspace
         FROM nodes_fts
         JOIN nodes n ON n.rowid = nodes_fts.rowid
         JOIN snapshots s ON s.id = n.snapshot_id
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY rank
         LIMIT ?`
      )
      .all(...params) as { symbol: string; file: string; line: number; kind: string; workspace: string }[];

    if (!rows.length) {
      return { content: [{ type: "text", text: `No symbols found matching "${query}".` }] };
    }

    const text = rows
      .map((r) => `${r.kind.padEnd(12)} ${r.symbol}\n             ${r.file}:${r.line}`)
      .join("\n");

    return {
      content: [{ type: "text", text: `Found ${rows.length} symbol(s):\n\n${text}` }],
      structuredContent: { results: rows },
    };
  }
);

// ── graph_impact ─────────────────────────────────────────────────────────────

server.registerTool(
  "graph_impact",
  {
    description:
      "Full reverse-impact analysis for a symbol: who calls it, which tables it touches, " +
      "who implements it (if it is an interface), and which classes inject it as a dependency. " +
      "Use this to understand the blast radius of changing a class or method.",
    inputSchema: {
      symbol: z
        .string()
        .describe(
          "Symbol to analyze. Use 'ClassName', 'ClassName.methodName', or just 'methodName'."
        ),
      workspace: z
        .string()
        .optional()
        .describe("Workspace root path. Omit to use the most recently indexed workspace."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ symbol, workspace }) => {
    const snap = getLatestSnapshot(workspace);
    if (!snap) return { content: [{ type: "text", text: NO_INDEX_MSG }] };

    const isQualified = symbol.includes(".");
    const className = isQualified ? symbol.split(".")[0] : symbol;
    const simpleMethod = isQualified ? symbol.split(".").slice(1).join(".") : symbol;

    const callers = db
      .prepare(
        `SELECT caller, caller_file AS callerFile, caller_line AS callerLine
         FROM call_edges WHERE snapshot_id = ? AND callee = ?`
      )
      .all(snap.snapId, simpleMethod) as { caller: string; callerFile: string; callerLine: number }[];

    const tableRefs = db
      .prepare(
        `SELECT table_name AS "table", operation, symbol, file, line
         FROM table_edges WHERE snapshot_id = ? AND (symbol = ? OR symbol LIKE ?)`
      )
      .all(snap.snapId, symbol, `${symbol}.%`) as {
        table: string;
        operation: string;
        symbol: string;
        file: string;
        line: number;
      }[];

    const implementors = db
      .prepare(
        `SELECT implementor FROM implements_edges WHERE snapshot_id = ? AND contract = ?`
      )
      .all(snap.snapId, className) as { implementor: string }[];

    const consumers = db
      .prepare(
        `SELECT consumer, field_name AS fieldName
         FROM injects_edges WHERE snapshot_id = ? AND dependency = ?`
      )
      .all(snap.snapId, className) as { consumer: string; fieldName: string }[];

    const lines: string[] = [
      `Impact analysis for "${symbol}" — workspace: ${snap.workspaceRoot}\n`,
      `CALLERS (${callers.length}):`,
      ...(callers.length
        ? callers.map((c) => `  ${c.caller} — ${c.callerFile}:${c.callerLine}`)
        : ["  none"]),
      `\nTABLE REFS (${tableRefs.length}):`,
      ...(tableRefs.length
        ? tableRefs.map((t) => `  [${t.operation}] ${t.table} via ${t.symbol} — ${t.file}:${t.line}`)
        : ["  none"]),
      `\nIMPLEMENTORS (${implementors.length}):`,
      ...(implementors.length ? implementors.map((i) => `  ${i.implementor}`) : ["  none"]),
      `\nINJECTED INTO (${consumers.length}):`,
      ...(consumers.length
        ? consumers.map((c) => `  ${c.consumer} (field: ${c.fieldName})`)
        : ["  none"]),
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        symbol,
        callers,
        tableRefs,
        implementors: implementors.map((i) => i.implementor),
        consumers,
      },
    };
  }
);

// ── graph_callers ─────────────────────────────────────────────────────────────

server.registerTool(
  "graph_callers",
  {
    description:
      "Find all methods that call a given method name. Returns caller symbol, file, and line.",
    inputSchema: {
      method: z
        .string()
        .describe("Simple method name (e.g. 'findById', not 'UserService.findById')"),
      workspace: z.string().optional().describe("Workspace root path"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ method, workspace }) => {
    const snap = getLatestSnapshot(workspace);
    if (!snap) return { content: [{ type: "text", text: NO_INDEX_MSG }] };

    const rows = db
      .prepare(
        `SELECT caller, caller_file AS callerFile, caller_line AS callerLine
         FROM call_edges WHERE snapshot_id = ? AND callee = ?`
      )
      .all(snap.snapId, method) as { caller: string; callerFile: string; callerLine: number }[];

    if (!rows.length) {
      return { content: [{ type: "text", text: `No callers found for method "${method}".` }] };
    }

    const text = rows.map((r) => `${r.caller} — ${r.callerFile}:${r.callerLine}`).join("\n");
    return {
      content: [{ type: "text", text: `${rows.length} caller(s) of "${method}":\n\n${text}` }],
      structuredContent: { method, callers: rows },
    };
  }
);

// ── graph_callees ─────────────────────────────────────────────────────────────

server.registerTool(
  "graph_callees",
  {
    description: "Find all methods called by a given symbol (what does this class or method invoke?).",
    inputSchema: {
      caller: z
        .string()
        .describe("Symbol name — 'ClassName' or 'ClassName.methodName'"),
      workspace: z.string().optional().describe("Workspace root path"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ caller, workspace }) => {
    const snap = getLatestSnapshot(workspace);
    if (!snap) return { content: [{ type: "text", text: NO_INDEX_MSG }] };

    const rows = db
      .prepare(
        `SELECT DISTINCT callee FROM call_edges
         WHERE snapshot_id = ? AND (caller = ? OR caller LIKE ?)`
      )
      .all(snap.snapId, caller, `${caller}.%`) as { callee: string }[];

    if (!rows.length) {
      return { content: [{ type: "text", text: `No outbound calls found for "${caller}".` }] };
    }

    const callees = rows.map((r) => r.callee);
    return {
      content: [
        { type: "text", text: `${callees.length} method(s) called by "${caller}":\n\n${callees.join("\n")}` },
      ],
      structuredContent: { caller, callees },
    };
  }
);

// ── graph_table ───────────────────────────────────────────────────────────────

server.registerTool(
  "graph_table",
  {
    description:
      "Find all code symbols that interact with a given database table and what SQL operations they perform (SELECT, INSERT, UPDATE, DELETE, MERGE).",
    inputSchema: {
      table: z.string().describe("Database table name (case-insensitive)"),
      operation: z
        .enum(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"])
        .optional()
        .describe("Filter by SQL operation type"),
      workspace: z.string().optional().describe("Workspace root path"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ table, operation, workspace }) => {
    const snap = getLatestSnapshot(workspace);
    if (!snap) return { content: [{ type: "text", text: NO_INDEX_MSG }] };

    const rows = operation
      ? (db
          .prepare(
            `SELECT symbol, file, line, operation FROM table_edges
             WHERE snapshot_id = ? AND lower(table_name) = lower(?) AND operation = ?`
          )
          .all(snap.snapId, table, operation) as {
          symbol: string;
          file: string;
          line: number;
          operation: string;
        }[])
      : (db
          .prepare(
            `SELECT symbol, file, line, operation FROM table_edges
             WHERE snapshot_id = ? AND lower(table_name) = lower(?)`
          )
          .all(snap.snapId, table) as {
          symbol: string;
          file: string;
          line: number;
          operation: string;
        }[]);

    if (!rows.length) {
      return { content: [{ type: "text", text: `No references to table "${table}" found.` }] };
    }

    const text = rows.map((r) => `[${r.operation}] ${r.symbol} — ${r.file}:${r.line}`).join("\n");
    return {
      content: [{ type: "text", text: `${rows.length} reference(s) to table "${table}":\n\n${text}` }],
      structuredContent: { table, references: rows },
    };
  }
);

// ── graph_implements ──────────────────────────────────────────────────────────

server.registerTool(
  "graph_implements",
  {
    description:
      "Look up interface implementation relationships in both directions: " +
      "'implementors' finds all classes that implement a given interface; " +
      "'contracts' finds all interfaces a given class implements.",
    inputSchema: {
      symbol: z.string().describe("Class or interface name"),
      direction: z
        .enum(["implementors", "contracts"])
        .describe(
          "'implementors' = who implements this interface. 'contracts' = what does this class implement."
        ),
      workspace: z.string().optional().describe("Workspace root path"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ symbol, direction, workspace }) => {
    const snap = getLatestSnapshot(workspace);
    if (!snap) return { content: [{ type: "text", text: NO_INDEX_MSG }] };

    if (direction === "implementors") {
      const rows = db
        .prepare(
          `SELECT implementor FROM implements_edges WHERE snapshot_id = ? AND contract = ?`
        )
        .all(snap.snapId, symbol) as { implementor: string }[];

      if (!rows.length) {
        return { content: [{ type: "text", text: `No classes implement "${symbol}".` }] };
      }
      const list = rows.map((r) => r.implementor);
      return {
        content: [
          { type: "text", text: `Classes implementing "${symbol}":\n\n${list.join("\n")}` },
        ],
        structuredContent: { contract: symbol, implementors: list },
      };
    } else {
      const rows = db
        .prepare(
          `SELECT contract FROM implements_edges WHERE snapshot_id = ? AND implementor = ?`
        )
        .all(snap.snapId, symbol) as { contract: string }[];

      if (!rows.length) {
        return {
          content: [{ type: "text", text: `"${symbol}" does not implement any tracked interfaces.` }],
        };
      }
      const list = rows.map((r) => r.contract);
      return {
        content: [
          { type: "text", text: `Interfaces implemented by "${symbol}":\n\n${list.join("\n")}` },
        ],
        structuredContent: { implementor: symbol, contracts: list },
      };
    }
  }
);

// ── graph_dependencies ────────────────────────────────────────────────────────

server.registerTool(
  "graph_dependencies",
  {
    description:
      "Inspect dependency injection relationships. " +
      "'injects' finds all dependencies a class consumes (its constructor/field injections). " +
      "'injected_by' finds all classes that inject a given class as a dependency.",
    inputSchema: {
      symbol: z.string().describe("Class name"),
      direction: z
        .enum(["injects", "injected_by"])
        .describe(
          "'injects' = what does this class consume. 'injected_by' = who injects this class."
        ),
      workspace: z.string().optional().describe("Workspace root path"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ symbol, direction, workspace }) => {
    const snap = getLatestSnapshot(workspace);
    if (!snap) return { content: [{ type: "text", text: NO_INDEX_MSG }] };

    if (direction === "injects") {
      const rows = db
        .prepare(
          `SELECT dependency, field_name AS fieldName
           FROM injects_edges WHERE snapshot_id = ? AND consumer = ?`
        )
        .all(snap.snapId, symbol) as { dependency: string; fieldName: string }[];

      if (!rows.length) {
        return {
          content: [{ type: "text", text: `"${symbol}" has no tracked injected dependencies.` }],
        };
      }
      const text = rows.map((r) => `${r.dependency} (field: ${r.fieldName})`).join("\n");
      return {
        content: [{ type: "text", text: `Dependencies injected into "${symbol}":\n\n${text}` }],
        structuredContent: { consumer: symbol, dependencies: rows },
      };
    } else {
      const rows = db
        .prepare(
          `SELECT consumer, field_name AS fieldName
           FROM injects_edges WHERE snapshot_id = ? AND dependency = ?`
        )
        .all(snap.snapId, symbol) as { consumer: string; fieldName: string }[];

      if (!rows.length) {
        return { content: [{ type: "text", text: `No classes inject "${symbol}".` }] };
      }
      const text = rows.map((r) => `${r.consumer} (field: ${r.fieldName})`).join("\n");
      return {
        content: [
          { type: "text", text: `"${symbol}" is injected into:\n\n${text}` },
        ],
        structuredContent: { dependency: symbol, consumers: rows },
      };
    }
  }
);

// ── graph_workspaces ──────────────────────────────────────────────────────────

server.registerTool(
  "graph_workspaces",
  {
    description:
      "List all workspaces indexed by the Docs Agent extension, with symbol counts and last index time. " +
      "Use this to find the correct workspace root path for other tools.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const rows = db
      .prepare(
        `SELECT w.root_path AS rootPath,
                w.last_indexed AS lastIndexed,
                COUNT(s.id) AS snapshotCount,
                (SELECT COUNT(*)
                 FROM nodes n2
                 JOIN snapshots s2 ON s2.id = n2.snapshot_id
                 WHERE s2.workspace_id = w.id
                   AND s2.id = (
                     SELECT id FROM snapshots
                     WHERE workspace_id = w.id
                     ORDER BY created_at DESC LIMIT 1
                   )
                ) AS nodeCount
         FROM workspaces w
         LEFT JOIN snapshots s ON s.workspace_id = w.id
         GROUP BY w.id
         ORDER BY w.last_indexed DESC`
      )
      .all() as {
      rootPath: string;
      lastIndexed: number;
      snapshotCount: number;
      nodeCount: number;
    }[];

    if (!rows.length) {
      return { content: [{ type: "text", text: NO_INDEX_MSG }] };
    }

    const text = rows
      .map((r) => {
        const date = r.lastIndexed ? new Date(r.lastIndexed).toISOString() : "never";
        return `${r.rootPath}\n  symbols: ${r.nodeCount}  snapshots: ${r.snapshotCount}  last indexed: ${date}`;
      })
      .join("\n\n");

    return {
      content: [{ type: "text", text: `${rows.length} indexed workspace(s):\n\n${text}` }],
      structuredContent: { workspaces: rows },
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
