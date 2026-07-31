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

const editors = [cursor, devin, antigravity, claude, vscode, zed, opencode, codex, gemini, copilot, copilotJetbrains, cursorAgent, commandcode, goose, kiro, codebuff];

// Build a unified source → display-label map from all editor modules
const editorLabels = {};
for (const editor of editors) {
  if (editor.labels) Object.assign(editorLabels, editor.labels);
}

// Per-adapter failures from the last getAllChats() pass. An adapter that throws is
// skipped so one broken editor cannot take down a scan, but the failure is recorded
// here rather than discarded: a missing better-sqlite3 native binding and an editor
// the user simply does not have both produce zero sessions, and only this tells them
// apart. See getAdapterErrors().
let adapterErrors = [];

// better-sqlite3 ships a prebuilt binary via an install script. npm >= 12 blocks
// install scripts by default, so a plain `npm i -g memhouse` leaves no binding and
// every SQLite-backed adapter reads zero sessions.
const MISSING_BINDING = /Could not locate the bindings file|Cannot find module 'better-sqlite3'/;

// Adapters that read sessions out of a SQLite store, so a dead binding costs
// sessions. Membership is narrower than `grep -l better-sqlite3 editors/*.js`:
// windsurf/devin also requires better-sqlite3, but only in getDevinApiKey() for
// usage — its getChats() is pure language-server RPC, so its sessions survive a
// broken binding and listing it here would raise a false alarm. antigravity is
// listed because its *offline* chats come from SQLite, though its live cascades,
// like devin's, come over RPC — a failure there is partial.
// Held as module references, not strings, so the reported name always matches the
// adapter's own `name`.
const SQLITE_BACKED = [antigravity, cursor, goose, opencode, zed].map((m) => m.name);

// Construct an in-memory database. Loading the module is not enough — better-sqlite3
// resolves the native binding lazily, on first open.
//
// This only answers "can SQLite work at all". It deliberately cannot tell whether a
// given editor's real store is readable: permissions, locking, corruption, and
// SQLCipher all pass this probe and fail later. Those are reported by the adapters
// themselves through adapter-errors.
function probeSqlite() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return { available: true };
  } catch (e) {
    const message = ((e && e.message) || String(e)).split('\n')[0];
    return { available: false, message, missingBinding: MISSING_BINDING.test(message) };
  }
}

// Cache only success. A failed probe must be retried: a long-running shipper daemon
// that warned about a missing binding should notice once the user installs it,
// rather than repeating the warning for the life of the process.
let sqliteProbe = null;
function sqliteStatus() {
  if (sqliteProbe === null) {
    const result = probeSqlite();
    if (result.available) sqliteProbe = result;
    return result;
  }
  return sqliteProbe;
}

/**
 * Get all chats from all editor adapters, sorted by most recent first.
 */
function getAllChats() {
  const chats = [];
  adapterErrors = [];
  adapterErrorSink.reset();
  for (const editor of editors) {
    try {
      const editorChats = editor.getChats();
      chats.push(...editorChats);
    } catch (e) {
      const message = (e && e.message) || String(e);
      adapterErrors.push({
        source: editor.name,
        message: message.split('\n')[0],
        missingBinding: MISSING_BINDING.test(message),
      });
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
 * Adapters that could not report their sessions: [{ source, message, missingBinding }].
 * Empty when every adapter ran clean.
 *
 * Two sources, because there are two ways an adapter goes quiet. One throws out of
 * getChats() and is recorded during the pass. The other is a dead SQLite binding,
 * which throws nowhere at all — the adapters catch it internally — so it is probed
 * for directly and reported against every SQLite-backed adapter at once.
 */
function getAdapterErrors() {
  const errors = adapterErrors.slice();
  for (const e of adapterErrorSink.recorded()) {
    errors.push({ source: e.source, message: e.message, detail: e.detail, missingBinding: MISSING_BINDING.test(e.message) });
  }
  const sqlite = sqliteStatus();
  if (!sqlite.available) {
    const already = new Set(errors.map((e) => e.source));
    for (const source of SQLITE_BACKED) {
      if (!already.has(source)) {
        errors.push({ source, message: sqlite.message, missingBinding: sqlite.missingBinding });
      }
    }
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
