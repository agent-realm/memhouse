// ClickHouse ingest layer — async, batched port of cache.js's scan/analyze path
// (initDb + analyzeAndStore + scanAll/scanAllAsync + cacheGSDProjects).
//
// The message-extraction and stats logic is copied verbatim from cache.js so the
// rows are byte-for-byte comparable to the SQLite output; only the storage calls
// change (synchronous better-sqlite3 statements → batched ClickHouse inserts).
//
// Batching: analyzeChat() computes a chat's rows in memory; the scanner accumulates
// rows across chats and flushes them to ClickHouse in chunks (one INSERT per N rows),
// because each ClickHouse insert is an HTTP round-trip — per-row inserts would crawl.

const fs = require('fs');
const path = require('path');
const { getClient } = require('./clickhouse');
const { initSchema } = require('./ch-schema');
const { getAllChats, getMessages, resetCaches } = require('./editors');

// ── path/source normalization (identical to cache.js) ─────────────────────────
function normalizeFolder(folder) {
  if (!folder) return folder;
  folder = folder.replace(/^file:\/\//, '');
  if (process.platform === 'win32') {
    try {
      folder = path.resolve(folder);
      try { folder = fs.realpathSync.native(folder); }
      catch { if (/^[a-zA-Z]:/.test(folder)) folder = folder[0].toUpperCase() + folder.slice(1); }
      folder = folder.replace(/\\$/, '');
      if (/^[A-Z]:$/.test(folder)) folder += '\\';
      folder = folder.replace(/\\/g, '/');
    } catch { folder = folder.replace(/\\/g, '/'); }
  } else {
    try { folder = fs.realpathSync(folder); } catch { /* path gone, keep as-is */ }
  }
  return folder;
}

function normalizeEditorSource(source) {
  if (source === 'windsurf') return 'devin';
  if (source === 'windsurf-next') return 'devin-next';
  return source;
}

// Coerce to an integer for Int64 columns. Some adapters (e.g. Codex) emit
// fractional-millisecond timestamps; JSONEachRow rejects a float for Int64.
// null/undefined pass through (Nullable columns). SQLite tolerated this via
// dynamic typing; ClickHouse needs it clean.
const int = (v) => (v == null ? null : Math.round(v));

const META_KEYS = ['_type', '_dbPath', '_filePath', '_port', '_csrf', '_https',
  '_rootBlobId', '_dataType', '_rawSource', '_originator', '_cliVersion', '_modelProvider'];

function pickMeta(chat) {
  const o = {};
  for (const k of META_KEYS) o[k] = chat[k];
  return JSON.stringify(o);
}

// Compute a chat's stats + message/tool rows. Mirrors cache.js analyzeAndStore.
// Returns null when the chat should be skipped (encrypted or no messages).
function analyzeChat(chat) {
  if (chat.encrypted) return null;
  let messages;
  try { messages = getMessages(chat); } catch { return null; }
  if (!messages || messages.length === 0) return null;

  const stats = {
    total: messages.length, user: 0, assistant: 0, tool: 0, system: 0,
    toolCalls: [], models: [],
    userChars: 0, assistantChars: 0,
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
  };

  const chatTs = chat.lastUpdatedAt || chat.createdAt || null;
  const chatSource = normalizeEditorSource(chat.source);
  const msgRows = [];
  const toolRows = [];
  let toolIdx = 0;
  let seq = 0;

  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    if (msg.role === 'user') {
      stats.user++;
      stats.userChars += text.length;
    } else if (msg.role === 'assistant') {
      stats.assistant++;
      stats.assistantChars += text.length;
      if (msg._toolCalls && msg._toolCalls.length > 0) {
        for (const tc of msg._toolCalls) {
          stats.toolCalls.push(tc.name);
          toolRows.push({
            chat_id: chat.composerId, idx: toolIdx++, tool_name: tc.name,
            args_json: JSON.stringify(tc.args || {}), source: chatSource,
            folder: chat.folder || null, timestamp: int(chatTs),
          });
        }
      } else {
        const toolMatches = text.match(/\[tool-call: ([^\]]+)\]/g);
        if (toolMatches) {
          for (const m of toolMatches) {
            const name = (m.match(/\[tool-call: ([^(]+)/)?.[1] || 'unknown').trim();
            stats.toolCalls.push(name);
            toolRows.push({
              chat_id: chat.composerId, idx: toolIdx++, tool_name: name,
              args_json: '{}', source: chatSource, folder: chat.folder || null, timestamp: int(chatTs),
            });
          }
        }
      }
      if (msg._inputTokens) stats.inputTokens += msg._inputTokens;
      if (msg._outputTokens) stats.outputTokens += msg._outputTokens;
      if (msg._cacheRead) stats.cacheRead += msg._cacheRead;
      if (msg._cacheWrite) stats.cacheWrite += msg._cacheWrite;
    } else if (msg.role === 'tool') {
      stats.tool++;
    } else if (msg.role === 'system') {
      stats.system++;
    }
    if (msg._model) stats.models.push(msg._model);

    const storedContent = text.length > 50000 ? text.substring(0, 50000) : text;
    msgRows.push({
      chat_id: chat.composerId, seq: seq++, role: msg.role, content: storedContent,
      model: msg._model || null,
      input_tokens: int(msg._inputTokens || null), output_tokens: int(msg._outputTokens || null),
      cache_read: int(msg._cacheRead || null), cache_write: int(msg._cacheWrite || null),
    });
  }

  const statRow = {
    chat_id: chat.composerId,
    total_messages: stats.total, user_messages: stats.user, assistant_messages: stats.assistant,
    tool_messages: stats.tool, system_messages: stats.system,
    tool_calls: JSON.stringify(stats.toolCalls), models: JSON.stringify(stats.models),
    total_user_chars: int(stats.userChars), total_assistant_chars: int(stats.assistantChars),
    total_input_tokens: int(stats.inputTokens), total_output_tokens: int(stats.outputTokens),
    total_cache_read: int(stats.cacheRead), total_cache_write: int(stats.cacheWrite),
  };

  return { statRow, msgRows, toolRows, bubbleCount: messages.length };
}

// ── insert helpers ────────────────────────────────────────────────────────────
async function insertChunked(table, rows, chunkSize) {
  if (!rows.length) return;
  const client = getClient();
  for (let i = 0; i < rows.length; i += chunkSize) {
    await client.insert({ table, values: rows.slice(i, i + chunkSize), format: 'JSONEachRow' });
  }
}

async function setMeta(key, value) {
  await getClient().insert({
    table: 'meta', values: [{ key, value: String(value), _ver: Date.now() }], format: 'JSONEachRow',
  });
}

// Ensure database + schema exist. Replaces cache.js initDb().
async function initDb() {
  const { ensureDatabase } = require('./clickhouse');
  await ensureDatabase();
  await initSchema(getClient());
}

// ── scan ──────────────────────────────────────────────────────────────────────
// Async, batched equivalent of cache.js scanAll/scanAllAsync. onProgress receives
// { scanned, analyzed, skipped, total } like the SQLite version (drives SSE later).
async function scanAllAsync(onProgress, opts = {}) {
  const client = getClient();
  const force = opts.force || false;
  if (force || opts.resetCaches) resetCaches();

  const chats = opts.chats || getAllChats();
  const total = chats.length;
  let scanned = 0, analyzed = 0, skipped = 0;

  // Existing-cache map (id → {ts, bc}) + which chats already have a stats row.
  const existing = {};
  const statTotals = new Map();
  const msgCounts = new Map();
  {
    const rs = await client.query({
      query: 'SELECT id, last_updated_at AS ts, bubble_count AS bc FROM chats', format: 'JSONEachRow',
    });
    for (const r of await rs.json()) existing[r.id] = { ts: r.ts, bc: r.bc };
    const rs2 = await client.query({ query: 'SELECT chat_id, total_messages FROM chat_stats', format: 'JSONEachRow' });
    for (const r of await rs2.json()) statTotals.set(r.chat_id, r.total_messages);
    // Crash recovery: a kill between the clear-deletes and the inserts — or
    // mid-flush on a large transcript — leaves fresh-looking chats/chat_stats
    // rows with a missing or PARTIAL transcript. The skip below must compare the
    // actual message row count to chat_stats.total_messages, not mere existence.
    const rs3 = await client.query({ query: 'SELECT chat_id, count() AS n FROM messages GROUP BY chat_id', format: 'JSONEachRow' });
    for (const r of await rs3.json()) msgCounts.set(r.chat_id, r.n);
  }

  for (const chat of chats) chat.folder = normalizeFolder(chat.folder);

  const nowVer = Date.now();
  const chatRows = [];
  const statRows = [];
  const msgRows = [];
  const toolRows = [];
  const clearIds = []; // chats whose old messages/tool_calls must be deleted (re-analysis)

  if (onProgress) onProgress({ scanned: 0, analyzed: 0, skipped: 0, total });

  for (const chat of chats) {
    scanned++;
    const chatTs = chat.lastUpdatedAt || chat.createdAt || 0;
    const chatBc = chat.bubbleCount || 0;

    // Skip if already cached, not newer, bubble count hasn't grown, and stats exist.
    const cached = existing[chat.composerId];
    let didAnalyze = false;
    let bubbleCount = chatBc;

    if (!force && cached && cached.ts && cached.ts >= chatTs && cached.bc >= chatBc
        && statTotals.has(chat.composerId)
        && (msgCounts.get(chat.composerId) || 0) === statTotals.get(chat.composerId)) {
      skipped++;
    } else if (!chat.encrypted && (chat.name || chat.bubbleCount > 0)) {
      const res = analyzeChat(chat);
      if (res) {
        statRows.push({ ...res.statRow, analyzed_at: nowVer, _ver: nowVer });
        for (const m of res.msgRows) msgRows.push(m);
        for (const t of res.toolRows) toolRows.push(t);
        bubbleCount = res.bubbleCount;
        if (existing[chat.composerId] || statTotals.has(chat.composerId)) clearIds.push(chat.composerId);
        didAnalyze = true;
        analyzed++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }

    chatRows.push({
      id: chat.composerId,
      source: normalizeEditorSource(chat.source),
      name: chat.name || null,
      mode: chat.mode || null,
      folder: chat.folder || null,
      created_at: int(chat.createdAt || null),
      last_updated_at: int(chat.lastUpdatedAt || null),
      encrypted: chat.encrypted ? 1 : 0,
      bubble_count: int(bubbleCount),
      _meta: pickMeta(chat),
      _ver: nowVer,
    });

    if (onProgress) onProgress({ scanned, analyzed, skipped, total });
    await new Promise((r) => setImmediate(r)); // yield so SSE progress flushes
  }

  // Clear superseded message/tool rows for re-analyzed chats (lightweight delete).
  // Empty on a first scan, so the common path is insert-only.
  if (clearIds.length) {
    await client.command({
      query: 'DELETE FROM messages WHERE chat_id IN {ids:Array(String)}',
      query_params: { ids: clearIds },
    });
    await client.command({
      query: 'DELETE FROM tool_calls WHERE chat_id IN {ids:Array(String)}',
      query_params: { ids: clearIds },
    });
  }

  await insertChunked('chats', chatRows, 5000);
  await insertChunked('chat_stats', statRows, 5000);
  await insertChunked('messages', msgRows, 1000);
  await insertChunked('tool_calls', toolRows, 5000);

  await setMeta('last_scan', nowVer);
  await setMeta('total_chats', total);

  await cacheGSDProjects();

  return { total, analyzed, skipped };
}

// ── GSD (async port of cache.js cacheGSDProjects) ───────────────────────────────
const gsd = require('./editors/gsd');

async function cacheGSDProjects() {
  const client = getClient();
  const rs = await client.query({
    query: 'SELECT DISTINCT folder FROM chats WHERE folder IS NOT NULL', format: 'JSONEachRow',
  });
  const knownFolders = (await rs.json()).map((r) => r.folder);

  const projects = gsd.getGSDProjects(knownFolders);
  const nowVer = Date.now();
  const projectRows = [];
  const phaseRows = [];
  const clearFolders = [];

  for (const p of projects) {
    projectRows.push({
      folder: p.folder, name: p.name ?? null, description: p.description ?? null,
      milestone: p.milestone ?? null, total_phases: int(p.totalPhases || 0),
      completed_phases: int(p.completedPhases || 0), active_phase: p.activePhase ?? null,
      todos: int(p.todos || 0), backlog: int(p.backlog || 0), notes: int(p.notes || 0),
      last_modified: int(p.lastModified ?? null), scanned_at: nowVer, _ver: nowVer,
    });
    clearFolders.push(p.folder);
    for (const ph of gsd.getGSDPhases(p.folder)) {
      phaseRows.push({
        id: `${p.folder}::${ph.phaseDir}`, folder: p.folder,
        phase_number: int(ph.number || 0), phase_name: ph.name ?? null, status: ph.status ?? null,
        total_tasks: int(ph.tasks.total || 0), completed_tasks: int(ph.tasks.completed || 0),
        has_plan: ph.hasPlan ? 1 : 0, has_research: ph.hasResearch ? 1 : 0,
        has_verification: ph.hasVerification ? 1 : 0, last_modified: int(ph.lastModified ?? null),
      });
    }
  }

  if (clearFolders.length) {
    await client.command({
      query: 'DELETE FROM gsd_phases WHERE folder IN {folders:Array(String)}',
      query_params: { folders: clearFolders },
    });
  }
  await insertChunked('gsd_projects', projectRows, 5000);
  await insertChunked('gsd_phases', phaseRows, 5000);
}

module.exports = { initDb, scanAllAsync, analyzeChat, cacheGSDProjects, normalizeFolder, normalizeEditorSource };
