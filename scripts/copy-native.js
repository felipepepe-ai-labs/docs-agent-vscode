const fs   = require('fs');
const path = require('path');

const root    = path.resolve(__dirname, '..');
const distMod = path.resolve(root, 'dist/node_modules');

// Clean previous run
fs.rmSync(distMod, { recursive: true, force: true });
fs.mkdirSync(distMod, { recursive: true });

// Resolve the real path of better-sqlite3 (pnpm uses a symlink)
const bsLink = path.resolve(root, 'node_modules/better-sqlite3');
const bsSrc  = fs.realpathSync(bsLink);
const bsDst  = path.resolve(distMod, 'better-sqlite3');
fs.cpSync(bsSrc, bsDst, { recursive: true });

// Minimal `bindings` shim — loads the .node file directly, no transitive deps
const bindingsDst = path.resolve(distMod, 'bindings');
fs.mkdirSync(bindingsDst, { recursive: true });
fs.writeFileSync(path.join(bindingsDst, 'package.json'), JSON.stringify({ name: 'bindings', main: 'bindings.js' }));
fs.writeFileSync(path.join(bindingsDst, 'bindings.js'), [
  "module.exports = function bindings(name) {",
  "  var n = typeof name === 'string' ? name : name.bindings;",
  "  return require('../better-sqlite3/build/Release/' + n);",
  "};",
].join('\n'));

console.log('better-sqlite3 + bindings shim written to dist/node_modules');

// Also copy to mcp-server/dist/node_modules — the MCP server runs as a standalone
// Node process and cannot share the extension host's node_modules at runtime.
const mcpDistMod = path.resolve(root, 'mcp-server/dist/node_modules');
fs.rmSync(mcpDistMod, { recursive: true, force: true });
fs.mkdirSync(mcpDistMod, { recursive: true });
fs.cpSync(bsSrc, path.resolve(mcpDistMod, 'better-sqlite3'), { recursive: true });
const mcpBindingsDst = path.resolve(mcpDistMod, 'bindings');
fs.mkdirSync(mcpBindingsDst, { recursive: true });
fs.writeFileSync(path.join(mcpBindingsDst, 'package.json'), JSON.stringify({ name: 'bindings', main: 'bindings.js' }));
fs.writeFileSync(path.join(mcpBindingsDst, 'bindings.js'), [
  "module.exports = function bindings(name) {",
  "  var n = typeof name === 'string' ? name : name.bindings;",
  "  return require('../better-sqlite3/build/Release/' + n);",
  "};",
].join('\n'));
console.log('better-sqlite3 + bindings shim written to mcp-server/dist/node_modules');
