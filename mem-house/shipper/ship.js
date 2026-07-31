#!/usr/bin/env node
// mem-house SHIPPER — parse-on-client (bet #1 in ../DESIGN.md). Runs the 17 editor
// adapters locally and ships TYPED rows into the house (sessions / messages /
// tool_calls, ../schema.sql). The typed evolution of agency/ingest.js: same host id,
// same ts interpolation, same batching discipline — but rows land in physical
// columns instead of a raw JSON blob.
//
// Data-plane rules (binding, see DESIGN.md):
//   - JSONEachRow, batches <= 2000 rows, async_insert=0 on EVERY insert — the house
//     stamps user_id MATERIALIZED currentUser(), which is empty during async flushes.
//   - DateTime64 values travel as 'YYYY-MM-DD HH:MM:SS.mmm' UTC strings (plain
//     format; ISO 'T'/'Z' forms parse unreliably under JSONEachRow). Nullable → null.
//   - Int64-bound values are integer-coerced (some adapters emit fractional ms).
//   - Re-shipping is always safe: ReplacingMergeTree(ingested_at) keyed
//     (session_id, user_id, seq) collapses to latest-wins at FINAL.
//
// CLI:  node ship.js                one incremental pass
//       node ship.js --loop [sec]   repeat every sec seconds (default 300)
//       node ship.js --full         ignore the incremental skip (re-ship everything)
//       node ship.js --ensure-schema  apply ../schema.sql and exit
//       node ship.js --stats        per-source counts from sessions_v and exit
//
// Env (DESIGN.md contract): MEMHOUSE_URL / MEMHOUSE_USER / MEMHOUSE_PASSWORD /
// MEMHOUSE_DB — defaults http://localhost:8123 / memhouse_root / '' / memhouse.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@clickhouse/client');
const { getAllChats, getAdapterErrors, getMessages, resetCaches } = require('../../editors');
const adapterErrorSink = require('../../editors/adapter-errors');

const BATCH_ROWS = 2000;   // insert batch ceiling (binding)
const TEXT_MAX = 50000;    // messages.text truncation
const ARGS_MAX = 20000;    // tool_calls.args truncation

// Stable host id: <shorthostname>-<8hex sha256(machine seed)> (memory-house convention).
function hostId() {
  const short = (os.hostname() || 'host').split('.')[0];
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}`;
  const h = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return `${short}-${h}`;
}

// UInt64 (as decimal string) = first 8 bytes big-endian of sha256 over the row's
// content fields. Decimal string survives JSONEachRow → UInt64 without precision loss.
function lineHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest().readBigUInt64BE(0).toString();
}

// DateTime64(3) wire format: 'YYYY-MM-DD HH:MM:SS.mmm' in UTC (see header note).
function chTs(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

// Per-message timestamp interpolated across [createdAt, lastUpdatedAt] — adapters
// don't expose per-message times, so we synthesize monotonic-by-seq ones that make
// sessions_v started/ended line up with the session bounds (same approximation as
// agency/ingest.js; documented in DESIGN.md).
function messageTs(chat, seq, total) {
  const start = chat.createdAt || chat.lastUpdatedAt || Date.now();
  const end = chat.lastUpdatedAt || chat.createdAt || start;
  if (total <= 1) return chTs(start);
  return chTs(start + Math.round((end - start) * (seq / (total - 1))));
}

// UInt64-bound coercion: integers only, never negative, garbage → 0.
function toInt(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function makeClient() {
  return createClient({
    url: process.env.MEMHOUSE_URL || 'http://localhost:8123',
    username: process.env.MEMHOUSE_USER || 'memhouse_root',
    password: process.env.MEMHOUSE_PASSWORD || '',
    database: process.env.MEMHOUSE_DB || 'memhouse',
    request_timeout: 300000, // full re-ships move tens of MB; don't cut inserts short
    clickhouse_settings: {
      // Int64/UInt64 back as JSON numbers — our values (counts, tokens) are < 2^53.
      output_format_json_quote_64bit_integers: 0,
      // With a 300s request_timeout the client warns unless progress headers
      // keep long requests alive through proxies/load balancers — enable them
      // (also silences the startup WARN on every ship/install run).
      // The interval MUST sit below the smallest idle timeout in the path:
      // 60s is the default for AWS ALB and nginx proxy_read_timeout, so a
      // longer interval emits nothing before the socket is dropped and the
      // setting only silences the warning. 30s leaves headroom for both.
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: '30000',
    },
  });
}

// Apply ../schema.sql statement by statement. Comments are stripped BEFORE the ';'
// split — schema comments legitimately contain semicolons.
async function ensureSchema(client) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
  const stripped = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const stmts = stripped.split(';').map((s) => s.trim()).filter(Boolean);
  for (const q of stmts) {
    await client.command({
      query: q,
      // allow_experimental_full_text_index: on 25.x the messages text indexes
      // are gated behind this flag (SUPPORT_IS_DISABLED without it); 26.x+
      // accepts it as a no-op. Query-scoped, so no server config or admin
      // rights are needed. Verified on 25.11 and 26.7.
      clickhouse_settings: { async_insert: 0, allow_experimental_full_text_index: 1 },
    });
  }
  return stmts.length;
}

// Incremental state: what the house already holds, keyed by session_id. We compare
// against extra.bubbleCount (the adapter's own cheap count, stored at ship time) —
// NOT message_count — because parsed-message count and bubbleCount are different
// units in several adapters (claude folds subagents, codex reports 0), and skipping
// must be decidable WITHOUT calling getMessages on every chat.
async function loadExisting(client) {
  const rs = await client.query({
    query: 'SELECT session_id, last_updated_at, message_count, extra FROM sessions FINAL WHERE user_id = currentUser()',
    format: 'JSONEachRow',
  });
  // Actual message rows per session: an interrupted re-ship (crash between the
  // clear-DELETE and the inserts, or mid-flush on a large transcript) leaves a
  // fresh-looking session row with a missing or PARTIAL transcript — the skip
  // must compare the real row count against the recorded message_count, not
  // merely check that some row exists.
  const mr = await client.query({
    query: 'SELECT session_id, count() AS n FROM messages FINAL WHERE user_id = currentUser() GROUP BY session_id',
    format: 'JSONEachRow',
  });
  const msgCounts = new Map();
  for (const r of await mr.json()) msgCounts.set(r.session_id, toInt(r.n));
  const map = new Map();
  for (const r of await rs.json()) {
    // DateTime64 comes back as 'YYYY-MM-DD HH:MM:SS.mmm' — re-parse as UTC.
    const ms = r.last_updated_at ? Date.parse(r.last_updated_at.replace(' ', 'T') + 'Z') : null;
    const bc = toInt(r.extra && r.extra.bubbleCount);
    const count = toInt(r.message_count);
    map.set(r.session_id, { ms, count, bc, intact: (msgCounts.get(r.session_id) || 0) === count });
  }
  return map;
}

// Regex fallback for adapters that render tool calls into text but don't expose
// m._toolCalls: matches '[tool-call: Name(' and '[tool-call: Name]' forms.
const TOOL_CALL_RE = /\[tool-call: ([^(\]]+)/g;

// Build the typed rows for one chat. Returns null when the chat is unreadable
// (adapter threw — e.g. a partially-written or locked session file): the caller
// must write NOTHING for it, so the next incremental pass retries. A chat that
// parses to zero messages still gets its session row (deliberate: the stored row
// absorbs the incremental skip for stable-empty chats).
function rowsForChat(chat, host) {
  let messages;
  try { messages = getMessages(chat) || []; } catch { return null; }

  const source = chat.source;
  // Canonical globally-unique session id: '<source>:<adapter-local id>'.
  // composerId is only unique WITHIN one editor; two editors emitting the same
  // id must never collide in keys, incremental state, deletes, or the API.
  // Sources are colon-free, so the prefix parses back unambiguously.
  const id = `${source}:${String(chat.composerId)}`;
  const folder = chat.folder || '';
  const project = folder ? path.basename(folder) : '';
  const total = messages.length;

  const session = {
    session_id: id,
    source,
    host,
    name: chat.name || '',
    mode: chat.mode || '',
    folder,
    project,
    git_branch: chat._gitBranch || '',
    created_at: chat.createdAt ? chTs(chat.createdAt) : null,
    last_updated_at: chat.lastUpdatedAt ? chTs(chat.lastUpdatedAt) : null,
    message_count: total,
    path: chat._fullPath || chat._dbPath || id,
    extra: { bubbleCount: chat.bubbleCount || 0 },
  };

  const msgRows = [];
  const toolRows = [];
  let idx = 0; // session-wide tool-call index
  for (let seq = 0; seq < total; seq++) {
    const m = messages[seq];
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content) ?? '';
    const text = raw.length > TEXT_MAX ? raw.slice(0, TEXT_MAX) : raw;
    const ts = messageTs(chat, seq, total);
    const row = {
      session_id: id,
      seq,
      source,
      host,
      ts,
      role: m.role || '',
      model: m._model || '',
      input_tokens: toInt(m._inputTokens),
      output_tokens: toInt(m._outputTokens),
      cache_read_tokens: toInt(m._cacheRead),
      cache_write_tokens: toInt(m._cacheWrite),
      text,
      project,
      folder,
      is_subagent: text.startsWith('[subagent]'),
      extra: {},
    };
    // Hash the content fields only (not ts — it is synthesized and may drift).
    row.line_hash = lineHash({
      session_id: id, seq, role: row.role, model: row.model,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens, cache_write_tokens: row.cache_write_tokens,
      text,
    });
    msgRows.push(row);

    if (m.role !== 'assistant') continue;
    let calls;
    if (Array.isArray(m._toolCalls) && m._toolCalls.length) {
      calls = m._toolCalls.map((tc) => ({ name: String(tc.name || 'unknown'), args: tc.args || {} }));
    } else {
      calls = [];
      for (const match of text.matchAll(TOOL_CALL_RE)) {
        calls.push({ name: match[1].trim(), args: {} });
      }
    }
    for (const tc of calls) {
      const args = JSON.stringify(tc.args);
      toolRows.push({
        session_id: id,
        seq,
        idx: idx++,
        source,
        host,
        tool_name: tc.name,
        args: args.length > ARGS_MAX ? args.slice(0, ARGS_MAX) : args,
        ts,
        project,
        folder,
      });
    }
  }
  return { session, msgRows, toolRows };
}

// One shipping pass. Incremental unless opts.full: a chat is skipped when the house
// already has it at least as fresh (last_updated_at) and at least as large
// (extra.bubbleCount) — both readable without parsing the chat.
async function runShip(client, opts = {}) {
  const { full = false } = opts;
  const host = hostId();
  // Always load what the house holds — even with --full. The skip decision uses it
  // only in incremental mode, but re-shipping a KNOWN session must clear its old
  // message/tool rows first (a shrunken re-parse leaves stale higher-seq rows
  // otherwise: ReplacingMergeTree collapses same-key rows only).
  const existing = await loadExisting(client);
  const chats = getAllChats();

  // An adapter that cannot load contributes zero sessions, which is indistinguishable
  // from an editor the user does not have — so the shipper would silently ship a
  // partial history forever. Say so on every pass.
  // Reported once here for what the scan already knows (a dead binding is visible
  // before any work happens, and this pass may take minutes), and again after the
  // loop for failures that only surface while reading messages.
  const warned = new Set();
  reportAdapterErrors(warned);

  const batches = { sessions: [], messages: [], tool_calls: [] };
  const flush = async (table) => {
    if (!batches[table].length) return;
    await client.insert({
      table,
      values: batches[table],
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 0 }, // binding: user_id stamping breaks otherwise
    });
    batches[table] = [];
  };
  const push = async (table, row) => {
    batches[table].push(row);
    if (batches[table].length >= BATCH_ROWS) await flush(table);
  };

  const seen = new Set(); // adapters must not double-ship a session id within a pass
  let sessions = 0, skipped = 0, msgRows = 0, toolRows = 0, unreadable = 0;
  for (const chat of chats) {
    if (chat.encrypted) continue;
    // Same canonical '<source>:<adapter-local id>' as rowsForChat: dedup and
    // incremental state are per (source, id) — two editors sharing an id must
    // not skip or overwrite each other.
    const id = `${chat.source}:${String(chat.composerId)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const prev = existing.get(id);
    if (!full && prev) {
      // floor: some adapters (codex) emit fractional-ms timestamps, but DateTime64(3)
      // stores whole ms — without it every such session loses by <1ms and re-ships.
      const chatLast = Math.floor(chat.lastUpdatedAt || chat.createdAt || 0);
      const notNewer = chatLast === 0 || (prev.ms !== null && prev.ms >= chatLast);
      // Freshness alone is not enough: the transcript must be COMPLETE (stored
      // row count == recorded message_count) so an interrupted re-ship — even one
      // that died mid-flush leaving a partial transcript — repairs itself on the
      // next pass instead of being skipped forever.
      if (notNewer && prev.bc >= (chat.bubbleCount || 0) && prev.intact) { skipped++; continue; }
    }

    // rowsForChat returns null only when getMessages() *throws*. An adapter that
    // swallows its own failure returns [] instead, which would look like a session
    // that genuinely has no messages — and for a known session the re-ship below
    // deletes the old transcript before inserting that emptiness. So treat a
    // failure recorded while reading THIS chat as unreadable too: write nothing,
    // delete nothing, retry next pass.
    const errsBefore = adapterErrorSink.recorded().length;
    const rows = rowsForChat(chat, host);
    const failedHere = adapterErrorSink.recorded().slice(errsBefore).some((e) => e.source === chat.source);
    if (!rows || failedHere) { unreadable++; continue; } // write nothing → retried next pass
    if (prev) {
      // Known session being re-shipped: clear its old rows BEFORE inserting so a
      // shorter re-parse can't leave stale seq/idx tails. A crash between the
      // delete and the inserts is repaired by the next pass: the skip predicate
      // refuses to skip a non-empty session whose message rows are missing.
      for (const t of ['messages', 'tool_calls']) {
        await client.command({
          query: `DELETE FROM ${t} WHERE session_id = {id:String} AND user_id = currentUser()`,
          query_params: { id },
          clickhouse_settings: { async_insert: 0 },
        });
      }
    }
    await push('sessions', rows.session);
    sessions++;
    for (const r of rows.msgRows) { await push('messages', r); msgRows++; }
    for (const r of rows.toolRows) { await push('tool_calls', r); toolRows++; }
  }
  for (const table of Object.keys(batches)) await flush(table);
  // Anything that only failed while reading messages — the sink is reset by the
  // next getAllChats(), so unreported here means never reported at all.
  reportAdapterErrors(warned);
  return { sessions, skipped, msgRows, toolRows, unreadable };
}

// Warn once per adapter per pass. `warned` carries across the two call sites so a
// dead binding is not reported twice in the same run.
function reportAdapterErrors(warned) {
  const errors = getAdapterErrors().filter((e) => !warned.has(e.source));
  if (!errors.length) return;
  for (const e of errors) warned.add(e.source);
  const noBinding = errors.filter((e) => e.missingBinding).map((e) => e.source);
  if (noBinding.length) {
    console.log(`[mem-house] WARNING: ${noBinding.length} adapter(s) skipped, sessions NOT shipped — better-sqlite3 has no native binding: ${noBinding.join(', ')}`);
    console.log('[mem-house]          fix: npm install -g memhouse --allow-scripts=better-sqlite3');
  }
  for (const e of errors.filter((x) => !x.missingBinding)) {
    console.log(`[mem-house] WARNING: ${e.source} skipped — ${e.message}`);
  }
}

// Per-source rollup straight from sessions_v (final=1 so ReplacingMergeTree collapses).
async function printStats(client) {
  const rs = await client.query({
    query: `
      SELECT source,
             count() AS sessions,
             sum(total_msgs) AS messages,
             sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
      FROM sessions_v
      GROUP BY source
      ORDER BY sessions DESC`,
    format: 'JSONEachRow',
    clickhouse_settings: { final: 1 },
  });
  const rows = await rs.json();
  if (!rows.length) { console.log('[mem-house] house is empty'); return; }
  const w = [Math.max(6, ...rows.map((r) => r.source.length)), 8, 8, 14];
  const line = (a, b, c, d) =>
    console.log(`${String(a).padEnd(w[0])}  ${String(b).padStart(w[1])}  ${String(c).padStart(w[2])}  ${String(d).padStart(w[3])}`);
  line('source', 'sessions', 'messages', 'tokens');
  let ts = 0, tm = 0, tt = 0;
  for (const r of rows) {
    line(r.source, r.sessions, r.messages, r.tokens);
    ts += Number(r.sessions); tm += Number(r.messages); tt += Number(r.tokens);
  }
  line('total', ts, tm, tt);
}

async function main() {
  const argv = process.argv.slice(2);
  const client = makeClient();
  try {
    if (argv.includes('--ensure-schema')) {
      const n = await ensureSchema(client);
      console.log(`[mem-house] schema ensured (${n} statements)`);
      return;
    }
    if (argv.includes('--stats')) { await printStats(client); return; }

    const loopIdx = argv.indexOf('--loop');
    const loop = loopIdx !== -1;
    let intervalSec = 300;
    if (loop) {
      const n = Number(argv[loopIdx + 1]);
      if (Number.isFinite(n) && n > 0) intervalSec = n;
    }
    let full = argv.includes('--full');
    do {
      const t0 = Date.now();
      try {
        const r = await runShip(client, { full });
        console.log(`[mem-house] shipped ${r.sessions} sessions (${r.skipped} skipped${r.unreadable ? `, ${r.unreadable} unreadable-will-retry` : ''}) → ` +
          `${r.msgRows} msg rows, ${r.toolRows} tool rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        console.error(`[mem-house] pass failed: ${e.message}`);
        if (!loop) process.exitCode = 1;
      }
      full = false; // --full applies to the first pass only; loop passes stay incremental
      if (loop) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
        resetCaches(); // adapters cache chat lists; drop them so new sessions surface
      }
    } while (loop);
  } finally {
    await client.close();
  }
}

module.exports = { runShip, ensureSchema };

if (require.main === module) {
  main().catch((e) => { console.error(`[mem-house] fatal: ${e.message}`); process.exit(1); });
}
