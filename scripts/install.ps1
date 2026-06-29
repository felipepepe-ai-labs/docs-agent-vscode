#Requires -Version 5.1
# Install docs-agent: builds the project, installs the VS Code extension,
# and registers the MCP server with Claude Code.
#
# Usage:
#   pnpm run install:ext:win
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# Requirements (hard):  node, pnpm
# Requirements (soft):  code  (VS Code CLI) — extension install skipped if absent
#                       claude (Claude Code CLI) — MCP registration skipped if absent
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Repo root ─────────────────────────────────────────────────────────────────
$Root     = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$McpEntry = Join-Path $Root 'mcp-server\dist\index.js'
$McpName  = 'code-graph'

# ── Color helpers ─────────────────────────────────────────────────────────────
function Step($msg) { Write-Host "▶ $msg" -ForegroundColor Cyan   }
function Ok($msg)   { Write-Host "✓ $msg" -ForegroundColor Green  }
function Warn($msg) { Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "✗ $msg" -ForegroundColor Red    }

function Have($cmd) {
    return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ── Preflight ─────────────────────────────────────────────────────────────────
Step 'Preflight'

if (-not (Have 'node')) {
    Err 'node not found in PATH — install Node.js: https://nodejs.org'
    exit 1
}

if (-not (Have 'pnpm')) {
    Err 'pnpm not found in PATH — install: npm install -g pnpm'
    exit 1
}

$HasCode = Have 'code'
if (-not $HasCode) {
    Warn "'code' CLI not found — extension install will be skipped"
    Warn "  Fix: VS Code → Command Palette → 'Shell Command: Install code command in PATH'"
}

$HasClaude = Have 'claude'
if (-not $HasClaude) {
    Warn "'claude' CLI not found — MCP registration will be skipped"
}

Ok 'Preflight passed'

# ── Build + package ───────────────────────────────────────────────────────────
Step 'Building and packaging  (pnpm run package)'
Push-Location $Root
try {
    pnpm run package
    if ($LASTEXITCODE -ne 0) { throw "pnpm run package failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Ok 'Package complete'

# ── Locate newest .vsix ───────────────────────────────────────────────────────
Step 'Locating .vsix'
$Vsix = Get-ChildItem -Path $Root -Filter 'docs-agent-*.vsix' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

if (-not $Vsix) {
    Err "No docs-agent-*.vsix found in $Root after packaging"
    exit 1
}
Ok "Found: $($Vsix.Name)"

# ── Install extension ─────────────────────────────────────────────────────────
if ($HasCode) {
    Step 'Installing extension into VS Code'
    code --install-extension $Vsix.FullName --force
    if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed (exit $LASTEXITCODE)" }
    Ok 'Extension installed'
} else {
    Warn 'Skipped extension install (no ''code'' CLI)'
}

# ── Verify MCP bundle exists ──────────────────────────────────────────────────
if (-not (Test-Path $McpEntry)) {
    Err "MCP entry not found after build: $McpEntry"
    Err 'The build:mcp step may have failed silently — check pnpm run package output above'
    exit 1
}

# ── Register MCP server ───────────────────────────────────────────────────────
if ($HasClaude) {
    Step "Registering MCP server '$McpName' with Claude Code (-s user)"

    # Forward slashes work fine as node path argument; avoids JSON escaping issues
    $McpEntryFwd = $McpEntry.Replace('\', '/')
    $McpJson     = "{`"type`":`"stdio`",`"command`":`"node`",`"args`":[`"$McpEntryFwd`"]}"

    # Remove existing registration first (ensures path stays current)
    claude mcp remove $McpName -s user 2>$null
    claude mcp add-json $McpName $McpJson -s user
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add-json failed (exit $LASTEXITCODE)" }

    Ok 'MCP server registered at user scope'
} else {
    Warn 'Skipped MCP registration (no ''claude'' CLI)'
    $McpEntryFwd = $McpEntry.Replace('\', '/')
    Write-Host '  Register manually:'
    Write-Host "    claude mcp add-json $McpName '{""type"":""stdio"",""command"":""node"",""args"":[""$McpEntryFwd""]}' -s user"
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ''
Ok 'Install complete'
Write-Host "  Extension : $($Vsix.Name)"
if ($HasCode)   { Write-Host '  VS Code   : installed ✓' }
else            { Write-Host '  VS Code   : skipped (no ''code'' CLI)' }
if ($HasClaude) { Write-Host "  MCP       : registered as '$McpName' (-s user) ✓" }
else            { Write-Host '  MCP       : skipped (no ''claude'' CLI)' }
Write-Host ''
if ($HasCode) {
    Warn 'Reload VS Code if the extension does not activate immediately'
}
