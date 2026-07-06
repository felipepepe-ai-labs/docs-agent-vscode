# Docs Agent

A VS Code extension that generates documentation from source code using a local LLM — with a built-in anti-hallucination guard that rejects any entry the model cannot cite with a file path and line number.

Targets Java (Spring Boot) and C# (ASP.NET Web Forms) codebases.

---

## How it works

Every piece of documentation Docs Agent generates must be grounded in the actual source. The LLM is required to output a structured JSON array where each entry carries the exact file path and 1-based line number of the symbol it documents. Entries that omit or fabricate those citations are silently rejected and counted — so you always know how much of the output was verifiable.

---

## Commands

| Command | Description |
|---|---|
| `Docs Agent: Document this file` | Documents the active file. Resolves its dependencies (interface for `*Impl` classes, imported DTOs) and sends the bundle to the LLM. Writes a `.md` file to the configured docs folder. |
| `Docs Agent: Generate project documentation suite` | Lets you pick from 11 document types (README, ADRs, C4 diagrams, user stories, functional spec, technical spec, API reference, data model, deployment guide, glossary) and generates them in one pass. |
| `Docs Agent: Show code graph` | Opens an interactive Three.js graph of the indexed workspace — classes, methods, interfaces, and SQL table references. Supports search, expand-on-click, Cypher-style queries, and jump-to-source. |
| `Docs Agent: Analyze impact` | Given a symbol name (class, method, or `Class.method`), shows everything that references it: callers, implementors, consumers (DI injection points), and SQL table operations. |
| `Docs Agent: Show dashboard` | Opens the graph dashboard with index stats, communities, recent indexing runs, token usage, search, and symbol detail panels. |
| `Docs Agent: Settings` | Opens the settings panel. |

---

## Setup

### Option 1 — Ollama (default)

1. Install [Ollama](https://ollama.com) and pull a model:
   ```bash
   ollama pull qwen3:35b
   ```
2. Make sure Ollama is running (`http://localhost:11434`).
3. Install the extension and open a Java or C# workspace.

### Option 2 — VS Code Language Model (GitHub Copilot)

1. Install GitHub Copilot (or another VS Code LM provider) and sign in.
2. Set `docsAgent.provider` to `vscode-lm` in settings.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `docsAgent.provider` | `ollama` | LLM provider: `ollama` or `vscode-lm` |
| `docsAgent.ollamaUrl` | `http://localhost:11434` | Ollama base URL |
| `docsAgent.model` | `qwen3:35b` | Ollama model name |
| `docsAgent.vscodeLmFamily` | *(empty)* | VS Code LM model family, e.g. `gpt-4o`. Empty = first available |
| `docsAgent.cbmPort` | `9749` | Port for a running codebase-memory-mcp HTTP server |
| `docsAgent.docsFolder` | `docs` | Output folder relative to workspace root |
| `docsAgent.language` | `english` | Output language for generated documentation: `english` or `spanish` |

---

## Code graph

On activation, Docs Agent tries to connect to a running codebase-memory-mcp HTTP server on `docsAgent.cbmPort` (`9749` by default). When CBM is available, the extension uses it as the primary code intelligence backend for graph layout, search, subgraphs, architecture summaries, and richer documentation context.

When CBM is not available, the code graph shows 0 nodes/edges. Install codebase-memory-mcp to enable full graph features.

Edge types indexed:

- **calls** — method invocations
- **implements** — class → interface / superclass
- **injects** — field-level dependency injection (`@Autowired`, constructor injection)
- **table** — SQL string literals referencing database tables (SELECT / INSERT / UPDATE / DELETE)

The graph powers the visual explorer, dashboard, impact analysis command, and per-file documentation enrichment with a live "Called by / SQL tables / Injected into" section.

---

## Development

Prerequisites: Node.js 22+, pnpm, `gcc`/`make` (for the native SQLite addon).

```bash
pnpm install
pnpm rebuild better-sqlite3   # compile native addon
pnpm run typecheck             # validate extension and webviews
pnpm run typecheck:mcp         # validate the MCP server package
pnpm run test                  # typecheck + vitest unit suite
pnpm run test:watch            # vitest in watch mode
pnpm run build                 # build extension, webviews, and MCP server
```

Press **F5** in VS Code to launch the Extension Development Host.

> **Packaging note**: before running `pnpm run package`, rebuild the native addon against VS Code's Electron runtime using `@electron/rebuild`.
