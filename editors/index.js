const cursor = require('./cursor');
const devin = require('./windsurf');
const antigravity = require('./antigravity');
const claude = require('./claude');
const vscode = require('./vscode');
const zed = require('./zed');
const opencode = require('./opencode');
const codex = require('./codex');
const gemini = require('./gemini');
const copilot = require('./copilot');
const copilotJetbrains = require('./copilot-jetbrains');
const cursorAgent = require('./cursor-agent');
const commandcode = require('./commandcode');
const goose = require('./goose');
const kiro = require('./kiro');
const codebuff = require('./codebuff');
const adapterErrorSink = require('./adapter-errors');
const scope = require('./scope');

const editors = [cursor, devin, antigravity, claude, vscode, zed, opencode, codex, gemini, copilot, copilotJetbrains, cursorAgent, commandcode, goose, kiro, codebuff];

// Build a unified source → display-label map from all editor modules
const editorLabels = {};
for (const editor of editors) {
  if (editor.labels) Object.assign(editorLabels, editor.labels);
}

// Per-adapter failures from the last getAllChats() pass. An adapter that throws is
// skipped so one broken editor cannot take down a scan, but the failure is recorded
// here rather than discarded: an unreadable store and an editor the user simply does
// not have both produce zero sessions, and only this tells them apart. See
// getAdapterErrors().
//
// There used to be a second, coarser class beside those: better-sqlite3's native
// binding could be missing outright, taking all five SQLite-backed adapters down at
// once for a reason none of them could see, so a separate probe ran an in-memory open
// and reported the verdict against every one of them. SQLite is `node:sqlite` now — it
// arrives with Node and cannot go missing — so that probe, its MISSING_BINDING regex,
// and the `missingBinding` flag they put on every error are gone. What remains is the
// per-store reporting the adapters do themselves: permissions, locking, corruption and
// schema drift are all still real and all still land here, one line per adapter.
let adapterErrors = [];

/**
 * Get all chats from all editor adapters, sorted by most recent first.
 */
function getAllChats() {
  const chats = [];
  adapterErrors = [];
  adapterErrorSink.reset();
  // MEMHOUSE_EDITORS narrows which adapters run; an unknown name throws rather than
  // shipping nothing (or everything) behind a typo. See scope.js.
  for (const editor of scope.selectEditors(editors, process.env.MEMHOUSE_EDITORS)) {
    // A refused MEMHOUSE_<EDITOR>_ROOTS is recorded at load; surface it here as this
    // adapter's error and skip it, rather than letting it scan nowhere and report zero.
    const w = scope.watching().find((x) => x.name === editor.name);
    if (w && w.error) { adapterErrors.push({ source: editor.name, message: w.error }); continue; }
    try {
      const editorChats = editor.getChats();
      chats.push(...editorChats);
    } catch (e) {
      const message = (e && e.message) || String(e);
      adapterErrors.push({ source: editor.name, message: message.split('\n')[0] });
    }
  }

  chats.sort((a, b) => {
    const ta = a.lastUpdatedAt || a.createdAt || 0;
    const tb = b.lastUpdatedAt || b.createdAt || 0;
    return tb - ta;
  });

  return chats;
}

/**
 * Adapters that could not report their sessions: [{ source, message, detail? }].
 * Empty when every adapter ran clean.
 *
 * Two sources, because there are two ways an adapter goes quiet. One throws out of
 * getChats() and is recorded during the pass. The other catches its own failure — a
 * locked state.vscdb, a thread blob that will not decompress, a schema the parser does
 * not know — and reports it through the adapter-errors sink so the shipper knows not to
 * overwrite a good stored transcript with a partial read.
 */
function getAdapterErrors() {
  const errors = adapterErrors.slice();
  for (const e of adapterErrorSink.recorded()) {
    errors.push({ source: e.source, message: e.message, detail: e.detail });
  }
  // One line per adapter, not one per failed query — a broken store is usually hit
  // many times in a single scan.
  const bySource = new Map();
  for (const e of errors) if (!bySource.has(e.source)) bySource.set(e.source, e);
  return Array.from(bySource.values());
}

/**
 * Get messages for a chat object, dispatching to the right editor adapter.
 */
function getMessages(chat) {
  const editor = editors.find((e) => e.name === chat.source);
  // Match variants: devin-next, antigravity, claude-code, vscode-insiders, plus legacy aliases.
  const resolvedEditor = editor || editors.find((e) =>
    chat.source && (
      chat.source.startsWith(e.name) ||
      (e.sources && e.sources.includes(chat.source)) ||
      (e.legacySources && e.legacySources.includes(chat.source))
    )
  );
  if (!resolvedEditor) return [];
  return resolvedEditor.getMessages(chat);
}

function resetCaches() {
  for (const editor of editors) {
    if (typeof editor.resetCache === 'function') editor.resetCache();
  }
}

/**
 * Get usage / quota data from all editors that support it.
 * Returns an array of usage objects, one per editor/variant.
 */
async function getAllUsage() {
  const results = [];
  for (const editor of editors) {
    if (typeof editor.getUsage !== 'function') continue;
    try {
      const usage = await editor.getUsage();
      if (!usage) continue;
      // Devin returns an array (one per variant), Cursor returns a single object
      if (Array.isArray(usage)) results.push(...usage);
      else results.push(usage);
    } catch { /* skip broken adapters */ }
  }
  return results;
}

/**
 * Get all artifacts for a given project folder from all editors.
 * Also scans for general/shared artifact files (plan.md, etc.).
 */
function getAllArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  const artifacts = [];

  // Collect from each editor that implements getArtifacts
  for (const editor of editors) {
    if (typeof editor.getArtifacts !== 'function') continue;
    try {
      artifacts.push(...editor.getArtifacts(folder));
    } catch { /* skip broken adapters */ }
  }

  // General / shared artifact files (not tied to any specific editor)
  if (folder) {
    try {
      artifacts.push(...scanArtifacts(folder, {
        editor: '_general',
        label: 'General',
        files: ['AGENTS.md', '.mcp.json', 'plan.md', 'progress.md', 'TODO.md', 'CONVENTIONS.md', 'ARCHITECTURE.md', 'PLANNING.md'],
        dirs: [],
      }));
    } catch { /* skip */ }
  }

  // Deduplicate by path — editor-specific entries take priority over general
  const seen = new Map();
  for (const a of artifacts) {
    const existing = seen.get(a.path);
    if (!existing || (existing.editor === '_general' && a.editor !== '_general')) {
      seen.set(a.path, a);
    }
  }
  return Array.from(seen.values());
}

/**
 * Get all MCP servers from all editors.
 * Also scans project folders for project-level MCP configs (.mcp.json, .cursor/mcp.json, etc.)
 */
function getAllMCPServers(projectFolders = []) {
  const { parseMcpConfigFile } = require('./base');
  const path = require('path');
  const fs = require('fs');
  const servers = [];

  // 1. Collect global MCP servers from each editor
  for (const editor of editors) {
    if (typeof editor.getMCPServers !== 'function') continue;
    try {
      servers.push(...editor.getMCPServers());
    } catch { /* skip broken adapters */ }
  }

  // 2. Scan project folders for project-level MCP configs
  const projectConfigs = [
    { file: '.mcp.json', editor: 'claude-code', label: 'Claude Code' },
    { file: '.cursor/mcp.json', editor: 'cursor', label: 'Cursor' },
    { file: '.vscode/mcp.json', editor: 'vscode', label: 'VS Code' },
    { file: '.gemini/settings.json', editor: 'gemini-cli', label: 'Gemini CLI' },
    { file: '.kiro/settings/mcp.json', editor: 'kiro', label: 'Kiro' },
  ];

  const seenProjects = new Set();
  for (const folder of projectFolders) {
    if (!folder || seenProjects.has(folder)) continue;
    seenProjects.add(folder);
    for (const pc of projectConfigs) {
      const configPath = path.join(folder, pc.file);
      if (!fs.existsSync(configPath)) continue;
      const found = parseMcpConfigFile(configPath, { editor: pc.editor, label: pc.label, scope: 'project' });
      for (const s of found) {
        s.projectFolder = folder;
      }
      servers.push(...found);
    }
  }

  // 3. Deduplicate by name+editor (keep first occurrence, prefer global over project)
  const seen = new Map();
  for (const s of servers) {
    const key = `${s.name}::${s.editor}::${s.scope}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  return Array.from(seen.values());
}

module.exports = { getAllChats, getAdapterErrors, getMessages, editors, editorLabels, resetCaches, getAllUsage, getAllArtifacts, getAllMCPServers };
