# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build

Use typecheck before builds when possible. The `test` script runs the typecheck
followed by the vitest unit suite in `test/`.

```bash
# Validate
pnpm run typecheck     # extension + webviews
pnpm run typecheck:mcp # MCP server package
pnpm run test:unit     # vitest unit tests (test/*.test.ts)
pnpm run test          # typecheck + unit tests

# Build all targets (extension + both webviews)
pnpm run build

# Build individually
pnpm run build:ext       # src/extension.ts → dist/extension.js (CJS)
pnpm run build:webview   # src/webview/graph-panel.ts → media/graph-panel.js (IIFE)
pnpm run build:settings  # src/webview/settings-panel.ts → media/settings-panel.js (IIFE)
pnpm run build:dashboard # src/webview/dashboard-panel.ts → media/dashboard-panel.js (IIFE)
pnpm run build:mcp       # mcp-server/src/index.ts → mcp-server/dist/index.js (ESM)

# Watch mode during development
pnpm run watch:ext
pnpm run watch:webview

# Package as .vsix
pnpm run package
```

Three TypeScript projects exist: root for the extension (CJS, Node), `src/webview/tsconfig.json` for browser webviews, and `mcp-server/tsconfig.json` for the standalone MCP server.

Unit tests live in `test/` (outside the root tsconfig `include`) and run with vitest. `vitest.config.ts` aliases the `vscode` module to `test/mocks/vscode.ts` so pure logic modules (`schema.ts`, `graph.ts`, `ollama.ts`, `context.ts`, `writer.ts`) are testable outside the extension host.

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

### Code graph (`src/graph.ts`, `src/cbm-runner.ts`)

Graph extraction depends entirely on codebase-memory-mcp (CBM). On activation, `initGraph` in `extension.ts`:
1. Checks whether CBM is reachable over HTTP on `docsAgent.cbmPort` (default `9749`).
2. If CBM is available, creates one `CbmManager` per workspace root and loads graph data through CBM queries.
3. If CBM is not available, the graph stays empty (0 nodes) — there is no local fallback.

`fromCbmQuery` adapts CBM's query results into the in-memory `CodeGraph`. Relation types handled include calls, implements, injects, and SQL table operations.

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

**Graph panel** (`src/panel.ts` + `src/webview/graph-panel.ts`): Renders the code graph using Three.js. Messages flow via `postMessage` / `onDidReceiveMessage`. The host sends `subgraph` / `stats` / `searchResults` / `queryAnswer` / `reloading` messages; the webview sends `search` / `expand` / `overview` / `query` / `reload` / `openFile`. CBM mode provides precomputed 3D positions; without CBM the graph is empty.

**Dashboard panel** (`src/dashboard-panel.ts` + `src/webview/dashboard-panel.ts`): Shows graph stats, communities, token usage, search results, and symbol detail.

**Settings panel** (`src/settings-panel.ts` + `src/webview/settings-panel.ts`): Simple form that reads/writes VS Code configuration via `postMessage`.

### Project documentation suite (`src/doctypes.ts`)

`DOC_TYPES` is a catalog of 11 document types (README, ADR, C4 diagrams, user stories, specs, API reference, data model, deployment guide, glossary). Each entry defines a `prompt(ctx)` factory returning `{ system, user }`. All system prompts share a grounding rules preamble that forbids inventing features not present in the code.

`buildProjectContext` (`src/project-context.ts`) auto-detects the project type from manifest files (`pom.xml` → Spring Boot, `.csproj` → .NET, etc.), builds a directory tree up to 3 levels deep, and samples up to 60,000 characters of source files, scored by naming patterns (controllers > services > repositories > models > config).

### Architectural primers (`src/primers/`)

Markdown files injected as the system prompt when documenting language-specific files:
- `springboot.md` — injected for `.java` files
- `webforms.md` — injected for `.cs` files
- `angular.md` — injected for `.ts` files **only when** `package.json` contains `"@angular/core"`

`loadPrimer` in `extension.ts` requires `workspaceRoot` to check the manifest. Add new primers by creating a `.md` file and extending `loadPrimer`.

## Key constraints

- codebase-memory-mcp is the only graph backend. When it's unreachable, code graph features (graph panel, dashboard stats/communities, impact queries) show 0 nodes/edges instead of falling back to a local parser.
- The webview CSP allows no inline scripts — only nonce-protected external scripts from `localResourceRoots`. Do not add `'unsafe-inline'` to the policy. Nonces must be generated with `crypto.randomUUID()`, never `Math.random()`.
- `context.ts` import resolution is hardcoded to `com.example.*` and `src/main/java`. Update both constants if the target Java package changes.
