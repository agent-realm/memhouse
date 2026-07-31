const path = require('path');
const fs = require('fs');
const os = require('os');

const Database = require('better-sqlite3');
const adapterErrors = require('./adapter-errors');

// Zed stores data in different locations depending on the platform
// - Windows: %LOCALAPPDATA%\Zed (not Roaming)
// - macOS: ~/Library/Application Support/Zed
// - Linux: ~/.config/Zed
function getZedDataPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(home, 'AppData', 'Local', 'Zed');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Zed');
    default: // linux, etc.
      return path.join(home, '.config', 'Zed');
  }
}

const THREADS_DB = path.join(getZedDataPath(), 'threads', 'threads.db');

// ============================================================
// Decompress zstd blob via CLI (with cross-platform support)
// ============================================================

function decompressZstd(buf) {
  const tmpIn = path.join(os.tmpdir(), `zed_thread_${Date.now()}.zst`);
  const tmpOut = tmpIn.replace('.zst', '.json');
  try {
    fs.writeFileSync(tmpIn, buf);

    // Try zstd CLI first
    try {
      const { execFileSync } = require('child_process');
      const zstdCmd = process.platform === 'win32' ? 'zstd.exe' : 'zstd';
      execFileSync(zstdCmd, ['-d', '-f', '-q', tmpIn, '-o', tmpOut], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      // Fallback: try using Node.js zstd library if available
      try {
        const zlib = require('zlib');
        // Check if Node version supports zstd natively (v22+)
        if (zlib.createZstdDecompress) {
          const decompressed = zlib.zstdDecompressSync(buf);
          fs.writeFileSync(tmpOut, decompressed);
        } else {
          throw new Error('zstd not available');
        }
      } catch {
        throw new Error('zstd decompression not available on this system');
      }
    }

    const data = fs.readFileSync(tmpOut, 'utf-8');
    return data;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ============================================================
// Query SQLite using better-sqlite3 (cross-platform)
// ============================================================

function queryDb(sql) {
  if (!fs.existsSync(THREADS_DB)) return [];
  try {
    const db = new Database(THREADS_DB, { readonly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch (e) {
    // Locked, inaccessible, or corrupt. Keep the scan alive but say so — silence
    // here reads as "the user does not use Zed".
    adapterErrors.record('zed', e, THREADS_DB);
    return [];
  }
}

// Zed's `threads` schema varies by version: `worktree_branch` exists in some builds
// and not others, and older builds lack `created_at`. Naming a column that is not
// there fails the WHOLE query with "no such column", which cost every Zed thread on
// this machine — silently, until the adapter started reporting. So ask the table what
// it has rather than assuming. Cached: the schema cannot change while we scan.
let threadColumns = null;
function getThreadColumns() {
  if (threadColumns) return threadColumns;
  if (!fs.existsSync(THREADS_DB)) return new Set();
  try {
    const db = new Database(THREADS_DB, { readonly: true });
    const cols = db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name);
    db.close();
    // PRAGMA on a missing or renamed table SUCCEEDS with zero rows rather than
    // throwing. Left unreported, that would cache an empty set, return no sessions,
    // and look exactly like an unused Zed install — the same silent whole-adapter
    // drop this function exists to end. Do not cache it either: the next scan should
    // look again rather than inherit the verdict.
    if (cols.length === 0) {
      adapterErrors.record('zed', new Error('threads table missing or unreadable — incompatible Zed schema'), THREADS_DB);
      return new Set();
    }
    threadColumns = new Set(cols);
    return threadColumns;
  } catch (e) {
    adapterErrors.record('zed', e, THREADS_DB);
    return new Set();
  }
}

// index.js calls this between passes of a long-running `ship --loop`. Without it the
// column set would be fixed for the life of the process, so a Zed upgrade mid-run
// would keep querying a column that no longer exists — or keep ignoring one newly
// added — until someone restarted the shipper.
function resetCache() {
  threadColumns = null;
}

function queryBlob(id) {
  if (!fs.existsSync(THREADS_DB)) return null;
  try {
    const db = new Database(THREADS_DB, { readonly: true });
    const row = db.prepare('SELECT data FROM threads WHERE id = ?').get(id);
    db.close();
    return row ? row.data : null;
  } catch (e) {
    // This is the message-blob read. A silent null here becomes a zero-message
    // session, which overwrites the stored transcript on re-ship.
    adapterErrors.record('zed', e, THREADS_DB);
    return null;
  }
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'zed';

function getChats() {
  const cols = getThreadColumns();
  if (cols.size === 0) return [];

  // Only these are relied on. Anything else is taken when the build provides it.
  const select = ['id', 'summary', 'updated_at', 'data_type', 'length(data) as data_size', 'parent_id'];
  const hasBranch = cols.has('worktree_branch');
  const hasCreated = cols.has('created_at');
  if (hasBranch) select.push('worktree_branch');
  if (hasCreated) select.push('created_at');

  const rows = queryDb(`SELECT ${select.join(', ')} FROM threads ORDER BY updated_at DESC`);

  return rows.map(row => ({
    source: 'zed',
    composerId: row.id,
    name: row.summary || null,
    // created_at when the build has it. Falling back to updated_at is not a
    // creation time — it just keeps the field non-null on builds that lack it.
    createdAt: (hasCreated && row.created_at) ? new Date(row.created_at).getTime()
      : (row.updated_at ? new Date(row.updated_at).getTime() : null),
    lastUpdatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    mode: 'thread',
    folder: null,
    encrypted: false,
    bubbleCount: 0,
    _dataType: row.data_type,
    _gitBranch: hasBranch ? row.worktree_branch : null,
  }));
}

function getMessages(chat) {
  const blob = queryBlob(chat.composerId);
  if (!blob) return [];

  let json;
  const dataType = chat._dataType || 'zstd';
  try {
    if (dataType === 'zstd') {
      json = decompressZstd(blob);
    } else {
      json = blob.toString('utf-8');
    }
  } catch (e) {
    // Decompression failed — usually no zstd CLI and no native zstd in this Node.
    // The thread exists and has content we cannot read, so this must be reported:
    // silently returning [] would overwrite its stored transcript on re-ship.
    adapterErrors.record('zed', e, THREADS_DB);
    return [];
  }

  let data;
  try { data = JSON.parse(json); }
  catch (e) {
    // Decompressed but undecodable — malformed, or a thread schema this parser does
    // not know. The thread has content, so returning [] unreported would let a
    // re-ship replace the stored transcript with nothing.
    adapterErrors.record('zed', e, THREADS_DB);
    return [];
  }

  const model = data.model?.model || null;
  const messages = [];
  for (const msg of data.messages || []) {
    if (msg.User) {
      const { text } = extractContent(msg.User.content);
      if (text) messages.push({ role: 'user', content: text });
    } else if (msg.Agent) {
      const { text, toolCalls } = extractContent(msg.Agent.content);
      if (text) messages.push({ role: 'assistant', content: text, _model: model, _toolCalls: toolCalls });
    }
  }
  return messages;
}

function extractContent(content) {
  if (!Array.isArray(content)) return { text: '', toolCalls: [] };
  const parts = [];
  const toolCalls = [];
  for (const block of content) {
    if (block.Text) {
      parts.push(block.Text);
    } else if (block.ToolUse) {
      const tu = block.ToolUse;
      let args = {};
      try {
        args = typeof tu.input === 'string' ? JSON.parse(tu.input) : (tu.input || {});
      } catch {}
      const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
      parts.push(`[tool-call: ${tu.name || 'tool'}(${argKeys})]`);
      toolCalls.push({ name: tu.name || 'tool', args });
    } else if (block.ToolResult) {
      const tr = block.ToolResult;
      const preview = (tr.content || tr.output || '').substring(0, 500);
      parts.push(`[tool-result: ${tr.tool_use_id || 'tool'}] ${preview}`);
    } else if (block.Thinking) {
      const text = typeof block.Thinking === 'string' ? block.Thinking : (block.Thinking.text || '');
      if (text) parts.push(`[thinking] ${text}`);
    }
  }
  return { text: parts.join('\n') || '', toolCalls };
}

const labels = { 'zed': 'Zed' };

function getMCPServers() {
  const results = [];
  // Zed stores MCP servers in ~/.config/zed/settings.json under context_servers key
  const settingsPath = path.join(getZedDataPath(), 'settings.json');
  if (!fs.existsSync(settingsPath)) return results;
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const servers = data.context_servers || {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (typeof cfg !== 'object') continue;
      const settings = cfg.settings || {};
      results.push({
        name,
        editor: 'zed',
        editorLabel: 'Zed',
        scope: 'global',
        configPath: settingsPath,
        command: settings.command || cfg.command || null,
        args: settings.args || cfg.args || [],
        env: settings.env ? Object.keys(settings.env) : [],
        url: settings.url || cfg.url || null,
        transport: (settings.url || cfg.url) ? 'http' : 'stdio',
        disabled: false,
        disabledTools: [],
      });
    }
  } catch {}
  return results;
}

module.exports = { name, labels, getChats, getMessages, getMCPServers, resetCache };
