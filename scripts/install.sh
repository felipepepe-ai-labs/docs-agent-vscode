#!/usr/bin/env bash
# Install docs-agent: builds the project, installs the VS Code extension,
# and registers the MCP server with Claude Code.
#
# Usage:
#   pnpm run install:ext
#   bash scripts/install.sh
#
# Requirements (hard):  node, pnpm
# Requirements (soft):  code  (VS Code CLI) — extension install skipped if absent
#                       claude (Claude Code CLI) — MCP registration skipped if absent
set -euo pipefail

# ── Repo root ─────────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_ENTRY="$ROOT/mcp-server/dist/index.js"
MCP_NAME="code-graph"

# ── Colors — disabled when not a TTY or NO_COLOR is set ─────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  c_green='\033[0;32m'
  c_yellow='\033[0;33m'
  c_red='\033[0;31m'
  c_cyan='\033[0;36m'
  c_reset='\033[0m'
else
  c_green='' c_yellow='' c_red='' c_cyan='' c_reset=''
fi

step() { printf "${c_cyan}▶ %s${c_reset}\n" "$*"; }
ok()   { printf "${c_green}✓ %s${c_reset}\n" "$*"; }
warn() { printf "${c_yellow}⚠ %s${c_reset}\n" "$*"; }
err()  { printf "${c_red}✗ %s${c_reset}\n" "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
step "Preflight"

if ! have node; then
  err "node not found in PATH — install Node.js: https://nodejs.org"
  exit 1
fi

if ! have pnpm; then
  err "pnpm not found in PATH — install: npm install -g pnpm"
  exit 1
fi

HAS_CODE=false
if have code; then
  HAS_CODE=true
else
  warn "'code' CLI not found — extension install will be skipped"
  warn "  Fix: VS Code → Command Palette → 'Shell Command: Install code command in PATH'"
fi

HAS_CLAUDE=false
if have claude; then
  HAS_CLAUDE=true
else
  warn "'claude' CLI not found — MCP registration will be skipped"
fi

ok "Preflight passed"

# ── Build + package ───────────────────────────────────────────────────────────
step "Building and packaging  (pnpm run package)"
cd "$ROOT"
pnpm run package
ok "Package complete"

# ── Locate newest .vsix ───────────────────────────────────────────────────────
step "Locating .vsix"
VSIX="$(ls -t "$ROOT"/docs-agent-*.vsix 2>/dev/null | head -n1 || true)"
if [ -z "$VSIX" ]; then
  err "No docs-agent-*.vsix found in $ROOT after packaging"
  exit 1
fi
ok "Found: $(basename "$VSIX")"

# ── Install extension ─────────────────────────────────────────────────────────
if $HAS_CODE; then
  step "Installing extension into VS Code"
  code --install-extension "$VSIX" --force
  ok "Extension installed"
else
  warn "Skipped extension install (no 'code' CLI)"
fi

# ── Verify MCP bundle exists ──────────────────────────────────────────────────
if [ ! -f "$MCP_ENTRY" ]; then
  err "MCP entry not found after build: $MCP_ENTRY"
  err "The build:mcp step may have failed silently — check pnpm run package output above"
  exit 1
fi

# ── Register MCP server ───────────────────────────────────────────────────────
if $HAS_CLAUDE; then
  step "Registering MCP server '$MCP_NAME' with Claude Code (-s user)"
  MCP_JSON="{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"$MCP_ENTRY\"]}"
  # Remove any existing registration first (ensures path stays current)
  claude mcp remove "$MCP_NAME" -s user 2>/dev/null || true
  claude mcp add-json "$MCP_NAME" "$MCP_JSON" -s user
  ok "MCP server registered at user scope"
else
  warn "Skipped MCP registration (no 'claude' CLI)"
  echo "  Register manually:"
  echo "    claude mcp add-json $MCP_NAME '{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"$MCP_ENTRY\"]}' -s user"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
printf "\n"
ok "Install complete"
printf "  Extension : %s\n" "$(basename "$VSIX")"
if $HAS_CODE;   then printf "  VS Code   : installed ✓\n"
                else printf "  VS Code   : skipped (no 'code' CLI)\n"; fi
if $HAS_CLAUDE; then printf "  MCP       : registered as '%s' (-s user) ✓\n" "$MCP_NAME"
                else printf "  MCP       : skipped (no 'claude' CLI)\n"; fi
printf "\n"
if $HAS_CODE; then
  warn "Reload VS Code if the extension does not activate immediately"
fi
