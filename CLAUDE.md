# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build

There is no test suite. Do not run the build after changes (per project policy).

```bash
# Build all targets (extension + both webviews)
pnpm run build

# Build individually
pnpm run build:ext       # src/extension.ts → dist/extension.js (CJS)
pnpm run build:webview   # src/webview/graph-panel.ts → media/graph-panel.js (IIFE)
pnpm run build:settings  # src/webview/settings-panel.ts → media/settings-panel.js (IIFE)

# Watch mode during development
pnpm run watch:ext
pnpm run watch:webview

# Package as .vsix
pnpm run package
```

Two separate `tsconfig.json` files exist: root for the extension (CJS, Node), and `src/webview/tsconfig.json` for webview code (browser).

## Architecture

### Core data flow

```
User triggers command
  → context.ts (build file + dependency bundle)
  → llm.ts     (route to Ollama or VS Code LM API)
  → schema.ts  (validate + reject entries without file:line citations)
  → writer.ts  (write .md to docsFolder)
```

### Anti-hallucination contract (`src/schema.ts`)

The extension's defining feature. Every LLM response is validated by `validateAndParse`: entries without both `file` (matching a `// FILE:` header in the prompt) and `line` (1-based integer) are silently rejected and counted. The prompt enforces this via `OUTPUT_SCHEMA_INSTRUCTION`. Do not relax these validation rules.

### Code graph (`src/graph.ts`, `src/indexer.ts`)

`buildGraph` walks the workspace and parses `.java` and `.cs` files using a **line-by-line regex + brace-depth state machine** (`ParseState`), not a real AST. It builds a `CodeGraph` with five edge types: `callEdges`, `tableEdges`, `implementsEdges`, `injectsEdges`, and nodes. The state machine assumes one class per file and does not handle nested classes.

Graph is loaded eagerly on extension activation from the SQLite DB cache (`src/db.ts`). If no snapshot exists, it re-indexes and saves. Up to `MAX_SNAPSHOTS = 10` snapshots are retained per workspace; older ones are pruned in the same transaction.

### SQLite persistence (`src/db.ts`)

Uses `better-sqlite3` (synchronous, native addon). **Must remain external to the esbuild bundle** (`--external:better-sqlite3`). The DB lives in VS Code's `globalStorageUri`. An FTS5 virtual table with trigram tokenizer enables fuzzy symbol search via `searchNodes`. The `nodes_fts` table is kept in sync via `AFTER INSERT` / `AFTER DELETE` triggers.

### LLM providers (`src/llm.ts`, `src/ollama.ts`)

Two providers selectable via the `docsAgent.provider` setting:
- `ollama`: HTTP POST to local Ollama instance (default `http://localhost:11434`)
- `vscode-lm`: VS Code Language Model API (GitHub Copilot or other installed LM extension)

VS Code LM has no `system` role — `chatVsCodeLm` prepends system content to the first user message before sending.

### Context bundling (`src/context.ts`)

`buildContext` reads the active file and resolves two dependency types for Java:
- `*Impl.java` files → looks for the matching interface in the same directory
- `import com.example.*` statements → resolves to `src/main/java/...`

C# has no dependency resolution yet. Context is formatted as a multi-section bundle with `// FILE: <path>` headers — these exact headers must appear in LLM output for citation validation to pass.

### Webview panels

**Graph panel** (`src/panel.ts` + `src/webview/graph-panel.ts`): Renders the code graph using Three.js. Messages flow via `postMessage` / `onDidReceiveMessage`. The host sends `subgraph` / `stats` / `searchResults` / `reloading` messages; the webview sends `search` / `expand` / `overview` / `reload` / `openFile`. `sendOverviewGraph` limits display to 120 nodes and 400 edges, skipping isolated nodes (degree 0). Call edges resolve callee names (stored as simple method names) via a suffix map.

**Settings panel** (`src/settings-panel.ts` + `src/webview/settings-panel.ts`): Simple form that reads/writes VS Code configuration via `postMessage`.

### Project documentation suite (`src/doctypes.ts`)

`DOC_TYPES` is a catalog of 11 document types (README, ADR, C4 diagrams, user stories, specs, API reference, data model, deployment guide, glossary). Each entry defines a `prompt(ctx)` factory returning `{ system, user }`. All system prompts share a grounding rules preamble that forbids inventing features not present in the code.

`buildProjectContext` (`src/project-context.ts`) auto-detects the project type from manifest files (`pom.xml` → Spring Boot, `.csproj` → .NET, etc.), builds a directory tree up to 3 levels deep, and samples up to 60,000 characters of source files, scored by naming patterns (controllers > services > repositories > models > config).

### Architectural primers (`src/primers/`)

Markdown files injected as the system prompt when documenting language-specific files:
- `springboot.md` — injected for `.java` files
- `webforms.md` — injected for `.cs` files

Add new primers by creating a `.md` file and extending `loadPrimer` in `extension.ts`.

## Key constraints

- `better-sqlite3` is a native Node binary. It **must** be listed in `.vscodeignore` only via the exception pattern (`!node_modules/better-sqlite3/**`) and excluded from esbuild with `--external:better-sqlite3`. Never bundle it.
- The webview CSP allows no inline scripts — only nonce-protected external scripts from `localResourceRoots`. Do not add `'unsafe-inline'` to the policy.
- `context.ts` import resolution is hardcoded to `com.example.*` and `src/main/java`. Update both constants if the target Java package changes.
