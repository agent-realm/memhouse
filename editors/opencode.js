const path = require('path');
const fs = require('fs');
const os = require('os');
// Required lazily. A top-level require makes this native module a load-time dependency
// of the whole adapter set: editors/index.js imports every adapter, so one missing
// binding threw before any adapter ran and `discover` reported ZERO editors — losing the
// eleven that need no native code at all. The adapterErrors path exists to degrade one
// adapter at a time, and a top-level throw walks straight past it.
let Database = null;
function openDb(...a) {
  if (!Database) Database = require('better-sqlite3');
  return new Database(...a);
}
const adapterErrors = require('./adapter-errors');

// OpenCode stores data in XDG-style paths across all platforms
function getOpenCodeStoragePath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
}

const STORAGE_DIR = getOpenCodeStoragePath();
const SESSION_DIR = path.join(STORAGE_DIR, 'session');
const MESSAGE_DIR = path.join(STORAGE_DIR, 'message');
const PART_DIR = path.join(STORAGE_DIR, 'part');

// OpenCode also stores data in a SQLite database
function getOpenCodeDbPath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

const DB_PATH = getOpenCodeDbPath();

// ============================================================
// Query SQLite using better-sqlite3
// ============================================================

function queryDb(sql) {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const db = openDb(DB_PATH, { readonly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch (e) {
    // The store exists but could not be read. Returning [] keeps one bad database
    // from killing the scan, but staying quiet would hide missing sessions.
    adapterErrors.record('opencode', e, DB_PATH);
    return [];
  }
}

function extractModelInfo(data) {
  let modelValue = null;
  let providerValue = null;

  if (typeof data?.modelID === 'string') {
    modelValue = data.modelID;
    providerValue = typeof data.providerID === 'string' ? data.providerID : null;
  } else if (data?.model && typeof data.model === 'object') {
    modelValue = typeof data.model.modelID === 'string' ? data.model.modelID : null;
    providerValue = typeof data.providerID === 'string'
      ? data.providerID
      : (typeof data.model.providerID === 'string' ? data.model.providerID : null);
  } else if (typeof data?.model === 'string') {
    modelValue = data.model;
    providerValue = typeof data.providerID === 'string' ? data.providerID : null;
  }

  return { modelValue, providerValue };
}

function extractTokenInfo(data) {
  const tokens = data?.tokens && typeof data.tokens === 'object' ? data.tokens : null;
  const cache = tokens?.cache && typeof tokens.cache === 'object' ? tokens.cache : null;

  return {
    inputTokens: tokens?.input,
    outputTokens: tokens?.output,
    cacheRead: cache?.read,
    cacheWrite: cache?.write,
  };
}

function getSqliteSessions() {
  return queryDb(
    `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
            p.worktree, p.name as project_name,
            (SELECT count(*) FROM message m WHERE m.session_id = s.id) as msg_count
     FROM session s LEFT JOIN project p ON s.project_id = p.id
     ORDER BY s.time_updated DESC`
  );
}

function getSqliteMessages(sessionId) {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    const db = openDb(DB_PATH, { readonly: true });
    const messages = db.prepare(
      `SELECT m.id as msg_id, m.data as msg_data, m.time_created
       FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC`
    ).all(sessionId);

    const result = [];
    for (const msg of messages) {
      let msgData;
      // A record we cannot decode is dropped from the transcript. Silently, that
      // yields a TRUNCATED history that looks complete — and a re-ship would replace
      // the full stored transcript with the shortened one. Report it so the shipper
      // refuses to overwrite good data with a partial read.
      try { msgData = JSON.parse(msg.msg_data); }
      catch (e) { adapterErrors.record('opencode', e, `message ${msg.msg_id}`); continue; }

      const role = msgData.role;
      if (!role) continue;

      const parts = db.prepare(
        `SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`
      ).all(msg.msg_id);

      const contentParts = [];
      for (const part of parts) {
        let partData;
        try { partData = JSON.parse(part.data); }
        catch (e) { adapterErrors.record('opencode', e, `part of message ${msg.msg_id}`); continue; }
        const type = partData.type;

        if (type === 'text' && partData.text) {
          contentParts.push(partData.text);
        } else if (type === 'thinking' || type === 'reasoning') {
          if (partData.text) contentParts.push(`[thinking] ${partData.text}`);
        } else if (type === 'tool-call' || type === 'tool_use' || type === 'tool-use' || type === 'tool') {
          const toolName = partData.name || partData.toolName || partData.tool || 'tool';
          let argKeys = '';
          try {
            const input = typeof partData.input === 'string' ? JSON.parse(partData.input) : (partData.input || partData.args || partData.arguments || partData.state?.input || {});
            argKeys = typeof input === 'object' ? Object.keys(input).join(', ') : '';
          } catch {}
          contentParts.push(`[tool-call: ${toolName}(${argKeys})]`);
        } else if (type === 'tool-result' || type === 'tool_result') {
          const preview = (partData.text || partData.output || partData.state?.output || '').substring(0, 500);
          contentParts.push(`[tool-result] ${preview}`);
        }
      }

      const content = contentParts.join('\n');
      if (!content) continue;

      const { modelValue, providerValue } = extractModelInfo(msgData);
      const { inputTokens, outputTokens, cacheRead, cacheWrite } = extractTokenInfo(msgData);

      result.push({
        role: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role,
        content,
        _model: modelValue,
        _provider: providerValue,
        _inputTokens: inputTokens,
        _outputTokens: outputTokens,
        _cacheRead: cacheRead,
        _cacheWrite: cacheWrite,
      });
    }

    db.close();
    return result;
  } catch (e) {
    // Message reads must report too, not just the session scan: an empty transcript
    // is written over the stored one on re-ship.
    adapterErrors.record('opencode', e, DB_PATH);
    return [];
  }
}

// ============================================================
// Scan JSON files from OpenCode storage
// ============================================================

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function getAllSessions() {
  const sessions = [];
  if (!fs.existsSync(SESSION_DIR)) return sessions;

  for (const projectHash of fs.readdirSync(SESSION_DIR)) {
    const projectDir = path.join(SESSION_DIR, projectHash);
    if (!fs.statSync(projectDir).isDirectory()) continue;

    let files;
    // Discovery-time drop: the project directory is there but will not enumerate, so
    // every session under it vanishes before anything downstream can miss it.
    try { files = fs.readdirSync(projectDir).filter(f => f.startsWith('ses_') && f.endsWith('.json')); }
    catch (e) { adapterErrors.record('opencode', e, projectDir); continue; }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const data = readJson(filePath);
      if (data && data.id) {
        sessions.push({ ...data, _filePath: filePath });
      } else {
        // The file was listed, so it exists. Failing to decode it drops the session
        // from discovery entirely — it reaches neither doctor nor the shipper, and
        // nothing downstream can miss what it never saw.
        adapterErrors.record('opencode', new Error('unreadable session metadata file'), filePath);
      }
    }
  }
  return sessions;
}

// Returns the message count, or null when it could not be determined. Null and 0
// are NOT interchangeable: bubbleCount feeds the shipper's skip predicate, and a
// zero standing in for "unknown" makes `prev.bc >= 0` trivially true, so the session
// is skipped before anything can read it — stale forever, on every incremental pass.
function getMessageCount(sessionId) {
  const sessionMsgDir = path.join(MESSAGE_DIR, sessionId);
  if (!fs.existsSync(sessionMsgDir)) return 0;

  try {
    return fs.readdirSync(sessionMsgDir).filter(f => f.startsWith('msg_') && f.endsWith('.json')).length;
  } catch (e) {
    adapterErrors.record('opencode', e, sessionMsgDir);
    return null;
  }
}

function getMessagesForSession(sessionId) {
  const sessionMsgDir = path.join(MESSAGE_DIR, sessionId);
  if (!fs.existsSync(sessionMsgDir)) return [];

  let files;
  try { files = fs.readdirSync(sessionMsgDir).filter(f => f.startsWith('msg_') && f.endsWith('.json')); }
  catch (e) {
    // The directory exists (checked above) but is unreadable — report it, or the
    // empty result overwrites the stored transcript on re-ship.
    adapterErrors.record('opencode', e, sessionMsgDir);
    return [];
  }

  const rawMsgs = [];
  for (const file of files) {
    const msgPath = path.join(sessionMsgDir, file);
    const msg = readJson(msgPath);
    // The file was listed, so it exists; failing to decode it drops a message from
    // the transcript and would let a re-ship overwrite the stored copy with less.
    if (!msg) { adapterErrors.record('opencode', new Error('unreadable message file'), msgPath); continue; }
    if (!msg.id) continue;
    rawMsgs.push(msg);
  }

  // Sort by creation time before building output
  rawMsgs.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));

  const messages = [];
  for (const msg of rawMsgs) {
    // Get parts for this message
    const msgPartDir = path.join(PART_DIR, msg.id);
    const parts = [];
    if (fs.existsSync(msgPartDir)) {
      try {
        const partFiles = fs.readdirSync(msgPartDir).filter(f => f.startsWith('prt_') && f.endsWith('.json'));
        for (const partFile of partFiles) {
          const partPath = path.join(msgPartDir, partFile);
          const part = readJson(partPath);
          if (part) parts.push(part);
          else adapterErrors.record('opencode', new Error('unreadable part file'), partPath);
        }
      } catch (e) {
        // The directory exists (checked above) but cannot be enumerated, so none of
        // the per-file records above ran and the message collapses to a bare [role]
        // placeholder. Unreported, that truncation would overwrite stored content.
        adapterErrors.record('opencode', e, msgPartDir);
      }
    }

    // Build content from parts
    const contentParts = [];
    for (const part of parts) {
      const type = part.type;

      if (type === 'text' && part.text) {
        contentParts.push(part.text);
      } else if (type === 'thinking' || type === 'reasoning') {
        if (part.text) contentParts.push(`[thinking] ${part.text}`);
      } else if (type === 'tool-call' || type === 'tool_use' || type === 'tool') {
        const toolName = part.name || part.toolName || part.tool || 'tool';
        const args = part.args || part.arguments || part.state?.input || {};
        const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
        contentParts.push(`[tool-call: ${toolName}(${argKeys})]`);
      } else if (type === 'tool-result' || type === 'tool_result') {
        const preview = (part.text || part.output || part.state?.output || '').substring(0, 500);
        contentParts.push(`[tool-result] ${preview}`);
      } else if (type === 'step-start' || type === 'step-finish') {
        // Skip metadata parts
      }
    }

    // If no parts with content, check if message itself has content
    if (contentParts.length === 0 && msg.role) {
      contentParts.push(`[${msg.role}]`);
    }

    const content = contentParts.join('\n');
    if (content) {
      const { modelValue, providerValue } = extractModelInfo(msg);
      const { inputTokens, outputTokens, cacheRead, cacheWrite } = extractTokenInfo(msg);

      messages.push({
        role: msg.role || 'assistant',
        content,
        _model: modelValue,
        _provider: providerValue,
        _inputTokens: inputTokens,
        _outputTokens: outputTokens,
        _cacheRead: cacheRead,
        _cacheWrite: cacheWrite,
        _finish: msg.finish,
        // The same time already used to sort above. Passing it on means the shipper
        // stores when the message was sent instead of interpolating a position.
        _ts: msg.time?.created,
      });
    }
  }

  return messages;
}

// ============================================================
// Adapter interface
// ============================================================

const name = 'opencode';

function getChats() {
  const seen = new Set();
  const chats = [];

  // 1. JSON file-based sessions (newer storage format)
  const fileSessions = getAllSessions();
  for (const s of fileSessions) {
    seen.add(s.id);
    const msgCount = getMessageCount(s.id);
    chats.push({
      source: 'opencode',
      composerId: s.id,
      name: s.title || null,
      createdAt: s.time?.created || null,
      lastUpdatedAt: s.time?.updated || null,
      mode: s.mode || 'opencode',
      folder: s.directory || null,
      encrypted: false,
      bubbleCount: msgCount ?? 0,
      _countUnknown: msgCount === null,
      _agent: s.agent,
      _model: s.modelID,
      _provider: s.providerID,
      _sessionData: s,
      _storageType: 'file',
    });
  }

  // 2. SQLite sessions (older/primary store) — add any not already found in files
  const dbSessions = getSqliteSessions();
  for (const row of dbSessions) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    chats.push({
      source: 'opencode',
      composerId: row.id,
      name: cleanTitle(row.title),
      createdAt: row.time_created || null,
      lastUpdatedAt: row.time_updated || null,
      mode: 'opencode',
      folder: row.worktree || row.directory || null,
      encrypted: false,
      bubbleCount: row.msg_count || 0,
      _storageType: 'sqlite',
    });
  }

  return chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

function cleanTitle(title) {
  if (!title) return null;
  if (title.startsWith('New session - ')) return null;
  return title.substring(0, 120) || null;
}

function getMessages(chat) {
  // Prefer file-based messages; fall back to SQLite.
  //
  // Failures on the file path are only failures of the READ if the fallback also
  // comes up empty. An unreadable message directory for a session that opencode.db
  // still holds in full is not a reason to withhold the session — and leaving those
  // entries in the sink would make the shipper do exactly that, forever. So they are
  // retracted once SQLite produces a transcript. Scoped to the file attempt, so any
  // truncation the SQLite reader reports about itself survives.
  const beforeFile = adapterErrors.mark();
  const fileMessages = getMessagesForSession(chat.composerId);
  const afterFile = adapterErrors.mark();
  if (fileMessages.length > 0) return fileMessages;

  const sqliteMessages = getSqliteMessages(chat.composerId);
  if (sqliteMessages.length > 0) adapterErrors.dropRange(beforeFile, afterFile);
  return sqliteMessages;
}

const labels = { 'opencode': 'OpenCode' };

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  // OpenCode: ~/.config/opencode/opencode.json (mcp key maps to mcpServers format)
  const globalConfig = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  const results = [];
  if (fs.existsSync(globalConfig)) {
    try {
      const data = JSON.parse(fs.readFileSync(globalConfig, 'utf-8'));
      const servers = data.mcp || {};
      for (const [name, cfg] of Object.entries(servers)) {
        if (typeof cfg !== 'object') continue;
        results.push({
          name,
          editor: 'opencode',
          editorLabel: 'OpenCode',
          scope: 'global',
          configPath: globalConfig,
          command: cfg.command || null,
          args: cfg.args || [],
          env: cfg.env ? Object.keys(cfg.env) : [],
          url: cfg.url || null,
          transport: cfg.type || (cfg.url ? 'http' : 'stdio'),
          disabled: false,
          disabledTools: [],
        });
      }
    } catch {}
  }
  return results;
}

module.exports = { name, labels, getChats, getMessages, getMCPServers };
