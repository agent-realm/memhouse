// agentlytics agency — deterministic ingest worker (the agent-desk tier: no LLM,
// so not a prompt-injection surface). Reuses agentlytics' 17 editor adapters and
// normalizes every editor into the realm's canonical `data` shape, then ships one
// row per message into <house>.raw. Idempotent: ReplacingMergeTree collapses
// byte-identical re-ships, so re-running is safe.

const os = require('os');
const crypto = require('crypto');
const { getAllChats, getMessages } = require('../editors');

// Stable host id: <shorthostname>-<8hex sha256(machine seed)> (memory-house convention).
function hostId() {
  const short = (os.hostname() || 'host').split('.')[0];
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}`;
  const h = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return `${short}-${h}`;
}

// UInt64 (as decimal string) = first 8 bytes big-endian of sha256 over the row's data.
function lineHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest().readBigUInt64BE(0).toString();
}

const isoAt = (ms) => new Date(ms).toISOString();

// Per-message timestamp interpolated between the session's created/updated bounds so
// ts is monotonic per message and started/ended line up with the session. agentlytics'
// getMessages doesn't carry per-message timestamps, so we synthesize ordered ones.
function messageTs(chat, seq, total) {
  const start = chat.createdAt || chat.lastUpdatedAt || Date.now();
  const end = chat.lastUpdatedAt || chat.createdAt || start;
  if (total <= 1) return isoAt(start);
  return isoAt(start + Math.round((end - start) * (seq / (total - 1))));
}

// One raw-table row per message, with canonical `data` (Claude-shaped, uniform across
// all 17 editors) so messages_v / sessions_v populate the same way for every editor.
function rowsForChat(chat, host) {
  if (chat.encrypted) return [];
  let messages;
  try { messages = getMessages(chat); } catch { return []; }
  if (!messages || !messages.length) return [];

  const source = chat.source;
  const path = chat._fullPath || chat._dbPath || `${source}:${chat.composerId}`;
  const total = messages.length;
  const rows = [];
  let seq = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const data = {
      type: m.role,
      sessionId: String(chat.composerId),
      timestamp: messageTs(chat, seq, total),
      uuid: `${chat.composerId}-${seq}`,
      parentUuid: seq > 0 ? `${chat.composerId}-${seq - 1}` : null,
      isSidechain: false,
      cwd: chat.folder || '',
      gitBranch: chat._gitBranch || '',
      message: {
        model: m._model || null,
        content,
        usage: {
          input_tokens: m._inputTokens || 0,
          output_tokens: m._outputTokens || 0,
          cache_read_input_tokens: m._cacheRead || 0,
          cache_creation_input_tokens: m._cacheWrite || 0,
        },
      },
    };
    rows.push({ source, host, config_dir: '', path, line_hash: lineHash(data), data });
    seq++;
  }
  return rows;
}

// Ship all local editor sessions into house.raw. `client` is an @clickhouse/client
// bound to the house DB, connected as the agency owner. async_insert=0 is REQUIRED so
// the server can stamp user_id = currentUser() (empty during an async flush).
async function runIngest(client, { onProgress, batchRows = 2000 } = {}) {
  const host = hostId();
  const chats = getAllChats();
  let shipped = 0, sessions = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await client.insert({ table: 'raw', values: batch, format: 'JSONEachRow', clickhouse_settings: { async_insert: 0 } });
    shipped += batch.length;
    batch = [];
  };
  for (const chat of chats) {
    const rows = rowsForChat(chat, host);
    if (rows.length) sessions++;
    for (const r of rows) {
      batch.push(r);
      if (batch.length >= batchRows) await flush();
    }
    if (onProgress) onProgress({ sessions, shipped: shipped + batch.length, editors: chats.length });
  }
  await flush();
  return { sessions, rows: shipped, editors: chats.length };
}

module.exports = { runIngest, rowsForChat, hostId, lineHash };
