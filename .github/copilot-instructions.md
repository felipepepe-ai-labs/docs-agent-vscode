# Docs Agent — VS Code Extension

VS Code extension that generates structured documentation for Java and C# codebases using a local LLM (Ollama) or the VS Code Language Model API.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript strict |
| Runtime | Node.js 22 (CJS for extension, IIFE for webviews) |
| Extension API | `vscode` |
| Bundler | esbuild — two separate configs (root + `src/webview/tsconfig.json`) |
| Package manager | pnpm |
| LLM | Ollama (local) or VS Code LM API |
| DB | `node:sqlite` (`DatabaseSync` built-in — no addon, no bundler exclusion) |
| Graph rendering | Three.js (webview) |

## Architecture

```
User triggers command
  → context.ts     (read active file + resolve Java/C# dependencies)
  → llm.ts         (route to ollama.ts or vscode-lm provider)
  → schema.ts      (validate anti-hallucination citations)
  → writer.ts      (write .md to docsFolder)
```

### Core subsystems

- **`src/context.ts`** — builds a multi-section bundle of source files with `// FILE: <path>` headers. Each section is wrapped in `<source_code>` delimiters to isolate content from LLM instructions.
- **`src/schema.ts`** — `validateAndParse`: rejects any doc entry missing `file` + `line` citation. Do NOT relax this validation. The `OUTPUT_SCHEMA_INSTRUCTION` enforces this in the LLM prompt.
- **`src/indexer.ts`** — line-by-line regex + brace-depth state machine (`ParseState`). Not an AST. One class per file assumed; nested classes not handled.
- **`src/db.ts`** — SQLite persistence via `DatabaseSync`. Uses local `runTransaction()` wrapper (`BEGIN`/`COMMIT`/`ROLLBACK`) — `DatabaseSync` has no `.transaction()` method. FTS5 trigram index for fuzzy symbol search.
- **`src/ollama.ts`** — NDJSON streaming with `leftover` buffer (chunk boundaries). SSRF guard: `assertSafeUrl` normalises IPv4-mapped IPv6 (`::ffff:`) before blocklist check.
- **`src/panel.ts`** — `openFile` resolves symlinks with `fs.realpathSync` and asserts workspace containment before calling `openTextDocument`.

## Critical Invariants

- **Citation contract**: every `SymbolDoc` entry must have `file` matching a `// FILE:` header in the prompt and a `line` (1-based integer). No exceptions.
- **`node:sqlite` transactions**: always use `runTransaction()`, never `db.exec('BEGIN')` inline without the wrapper.
- **Webview CSP**: no `'unsafe-inline'`. Nonces via `crypto.randomUUID()` only.
- **`openFile` symlink guard**: always `realpathSync` + workspace containment before opening any file from webview messages.
- **SSRF**: `assertSafeUrl` must remain in place on every Ollama request. Do not bypass it.
- **No build after changes** — do not run `pnpm build` or `pnpm watch` after edits.

## GitFlow

| Branch | Base | PR target |
|--------|------|-----------|
| `hotfix/*` | `main` | `main` |
| `feature/*` | `develop` | `develop` |

Direct commits to `main` or `develop` are forbidden.

## Relevant Skills

Auto-load from the global Copilot skills catalog when context matches:

| Context | Skill |
|---------|-------|
| Security audit, auth, SSRF, path traversal | `red-team-offensive` |
| Code review before PR | `code-reviewer` |
| Async errors, swallowed exceptions, missing propagation | `silent-failure-hunter` |
| SQLite schema, queries, transactions | `db-architect` |
| Creating or preparing a PR | `branch-pr` |
| Running tests (vitest) | `test-runner` |
| SQLite storage, FTS5, indexing strategy | `ddia-storage-retrieval` |
| Transaction design, WAL, atomicity, isolation | `ddia-transactions` |
| Graph schema, relational vs. document trade-offs | `ddia-data-models` |
| Architectural trade-offs, any system design decision | `ddia-architecture-tradeoffs` |
| Any DDIA question — auto-routes to the right skill | `ddia-skill-router` |
