#!/usr/bin/env node
// memhouse SHIPPER — parse-on-client (bet #1 in ../DESIGN.md). Runs the 17 editor
// adapters locally and ships TYPED rows into THE CALLER'S OWN rooms — sessions_<m> /
// messages_<m> / tool_calls_<m>, where <m> is `SELECT currentUser()` and never config
// (../per-member/schema-member.sql.tpl, ../per-member/rooms.js). All of one member's
// machines land in that member's rooms, told apart by the `host` column; no member
// writes into another's. The typed evolution of agency/ingest.js: same host id,
// same ts interpolation, same batching discipline — but rows land in physical
// columns instead of a raw JSON blob.
//
// Data-plane rules (binding, see DESIGN.md):
//   - JSONEachRow, batches <= 2000 rows, async_insert=0 on EVERY insert — the house
//     stamps user_id MATERIALIZED currentUser(), which is empty during async flushes.
//   - DateTime64 values travel as 'YYYY-MM-DD HH:MM:SS.mmm' UTC strings (plain
//     format; ISO 'T'/'Z' forms parse unreliably under JSONEachRow). Nullable → null.
//   - Int64-bound values are integer-coerced (some adapters emit fractional ms).
//   - Re-shipping is always safe: ReplacingMergeTree(ingested_at) collapses to
//     latest-wins at FINAL. Keyed (session_id, user_id, origin, seq) on messages and
//     (session_id, user_id, origin, idx) on tool_calls, so an imported row and a shipped
//     one at the same seq are two rows, not one. sessions is (session_id, user_id) with
//     NO origin — one metadata row per session is what every read path assumes.
//
// CLI:  node ship.js                one incremental pass
//       node ship.js --loop [sec]   repeat every sec seconds (default 300)
//       node ship.js --full         ignore the incremental skip (re-ship everything)
//       node ship.js --ensure-schema  create the caller's own rooms and exit
//       node ship.js --stats        per-source counts from sessions_v and exit
//
// Env (DESIGN.md contract): MEMHOUSE_URL / MEMHOUSE_USER / MEMHOUSE_PASSWORD /
// MEMHOUSE_DB. URL and USER are REQUIRED — there is no default house, because the old
// one (http://localhost:8123 as memhouse_root) is a real house on many machines. DB
// defaults to 'mem'.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient, ClickHouseLogLevel } = require('@clickhouse/client');
const { getAllChats, getAdapterErrors, getMessages, resetCaches } = require('../../editors');
const adapterErrorSink = require('../../editors/adapter-errors');
const { resolveRooms, READ_SETTINGS, ROOM_TYPES } = require('../per-member/rooms');

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

// When a message was actually sent.
//
// Prefer the adapter's own `_ts` (epoch ms). It is optional by contract — `getMessages`
// returns `{ role, content }` and nothing more is required — but a transcript format that
// records a time per line should not have it thrown away. Claude Code's JSONL does, and
// discarding it produced timestamps wrong by up to the whole span of a session: four
// messages sent within three minutes came back spread over 08:00, 18:43, 03:27 and 12:11,
// and the search skill reported those to the user as fact.
//
// Fall back to interpolating across [createdAt, lastUpdatedAt] for the adapters that
// genuinely have nothing per message — monotonic-by-seq, so sessions_v started/ended
// still line up with the session bounds (same approximation as agency/ingest.js;
// documented in DESIGN.md). Real timestamps are NOT necessarily monotonic by seq — a
// folded subagent transcript is appended after its parent's turns but ran during them.
// Nothing depends on that: ordering is by `seq`, and started/ended are min/max.
function messageTs(chat, seq, total, msg) {
  const at = Number(msg && msg._ts);
  // Seconds or milliseconds, depending on the format: goose stores seconds, Claude Code
  // and opencode milliseconds. Real epoch-ms is > 1e12 and real epoch-seconds ~1.7e9, so
  // the split point is unambiguous for any date this side of 1973.
  if (Number.isFinite(at) && at > 0) return chTs(at < 1e11 ? at * 1000 : at);
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
  // No house-shaped default. `memhouse` spawns this with the resolved config in the
  // environment, so a missing MEMHOUSE_URL here means the shipper was started some other
  // way — a stale service unit, a hand-rolled cron, a copied command — and the old
  // defaults sent it at http://localhost:8123 as memhouse_root, which on a lot of machines
  // is a real house belonging to someone else. Writing memory into it is worse than
  // reading from it.
  if (!process.env.MEMHOUSE_URL || !process.env.MEMHOUSE_USER) {
    console.error('[memhouse] no house configured: MEMHOUSE_URL and MEMHOUSE_USER are unset.');
    console.error('[memhouse] run `memhouse install`, or set them for this process. Refusing to');
    console.error('[memhouse] guess http://localhost:8123 as memhouse_root.');
    process.exit(2);
  }
  return createClient({
    // The driver logs a full connection-object dump and a node stack to stderr for every
    // failed request, at ERROR level, BEFORE we get the exception. A member without
    // CREATE TABLE then sees 23 lines of @clickhouse/client internals and the word "fatal"
    // ahead of the handled, actionable refusal — it reads like a crash that recovered.
    // Silence the driver; every call site already catches the throw and prints something
    // a person can act on. MEMHOUSE_DEBUG=1 puts it back.
    log: { level: process.env.MEMHOUSE_DEBUG ? ClickHouseLogLevel.DEBUG : ClickHouseLogLevel.OFF },
    url: process.env.MEMHOUSE_URL,
    username: process.env.MEMHOUSE_USER,
    password: process.env.MEMHOUSE_PASSWORD || '',
    database: process.env.MEMHOUSE_DB || 'mem',
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

// Create the CALLER'S OWN rooms, from ../per-member/schema-member.sql.tpl. Comments are
// stripped BEFORE the ';' split — schema comments legitimately contain semicolons.
//
// This is the solo path: on a house you own, `memhouse install` mints your three rooms and
// you are done. It creates nobody else's — the template is rendered for currentUser(), the
// same identity the rooms' user_id is stamped with, so a client cannot name its way into
// someone else's rooms.
//
// It does NOT issue grants or create the Merge rooms. A solo owner needs neither. Adding a
// SECOND member — grants, Merge rooms, sharing — is owner work and lives in
// ../per-member/provision.js.
/**
 * Refuse to write into rooms whose sorting key is wrong for `origin` — in EITHER
 * direction. Two different houses are broken in two opposite ways:
 *
 *   - pre-0.4.4: no `origin` in the messages/tool_calls key, so ReplacingMergeTree
 *     collapses an imported row against a shipped one and the import is lost.
 *   - 0.4.4 exactly: `origin` was also put in the SESSIONS key, which gives a session
 *     two metadata rows. sessions_v then joins messages twice and over-reports, and the
 *     incremental skip cannot tell which row is current.
 *
 * Called at the top of EVERY ship pass, not just --ensure-schema: a plain `memhouse ship`
 * never touches ensureSchema, so a guard living only there is a guard that never runs on
 * the path that does the damage. Found exactly that way — the refusal was in place and
 * 137 sessions shipped straight past it into a stale-key house.
 */
async function assertOriginKeyed(client, rooms) {
  const wrong = [];
  for (const t of ROOM_TYPES) {
    const rs = await client.query({
      query: `SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = {n:String}`,
      query_params: { n: rooms[t] }, format: 'JSONEachRow',
    });
    const key = ((await rs.json())[0] || {}).sorting_key || '';
    if (!key) continue;
    const keyed = /\borigin\b/.test(key);
    // sessions is one row per session and must NOT key on origin; the transcript rooms
    // hold many rows per session and must.
    const want = t !== 'sessions';
    if (keyed !== want) {
      wrong.push(`${rooms[t]} (${key}) — origin ${want ? 'missing from' : 'must not be in'} the key`);
    }
  }
  if (wrong.length) {
    throw new Error(
      'these rooms have the wrong sorting key, so a ship pass would corrupt them:\n'
      + wrong.map((s) => `    ${s}`).join('\n')
      + '\n  ORDER BY cannot be altered in place. Rebuild each room, then re-ship:'
      + '\n    RENAME TABLE <room> TO <room>_old;'
      + '\n    -- recreate from memhouse/per-member/schema-member.sql.tpl'
      + '\n    INSERT INTO <room> SELECT * FROM <room>_old;'
      + '\n  (add `, \'ship\' AS origin` to the SELECT only if <room>_old has no origin column)'
      + '\n  A house with no imported rows can also just be re-shipped from scratch.');
  }
}

async function ensureSchema(client) {
  const rooms = await resolveRooms(client);
  const { member } = rooms;
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'per-member', 'schema-member.sql.tpl'), 'utf-8');
  const sql = tpl.replaceAll('{{MEMBER}}', member);
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
  // A house created before origin existed has no such column, and the clear binds it —
  // an unguarded DELETE there would be the old destructive behaviour, and a guarded one
  // would error. Add it in place; ReplacingMergeTree backfills the DEFAULT, so every
  // pre-existing row reads as 'ship', which is what it was.
  //
  // Deliberately NOT applied to the Merge rooms: they take their structure from a member
  // room at CREATE time and reject ALTER. A Merge room simply will not expose `origin`
  // until it is recreated, which costs nothing — nothing reads origin through it.
  for (const t of ROOM_TYPES) {
    try {
      await client.command({
        query: `ALTER TABLE ${rooms[t]} ADD COLUMN IF NOT EXISTS origin LowCardinality(String) DEFAULT 'ship'`,
        // 25.11 refuses ANY alter on a table carrying the messages text indexes unless
        // this is set — including an ADD COLUMN that has nothing to do with them
        // (Code: 344, SUPPORT_IS_DISABLED). Without it the backfill fails silently and
        // the guard ends up missing on precisely the houses that need upgrading. A no-op
        // on 26.x, and query-scoped, so it needs no server config.
        clickhouse_settings: { allow_experimental_full_text_index: 1 },
      });
    } catch { /* no rights to alter is not fatal: a member on someone else's house */ }
  }

  await assertOriginKeyed(client, rooms);
  return stmts.length;
}

// Incremental state: what the house already holds, keyed by session_id. We compare
// against extra.bubbleCount (the adapter's own cheap count, stored at ship time) —
// NOT message_count — because parsed-message count and bubbleCount are different
// units in several adapters (claude folds subagents, codex reports 0), and skipping
// must be decidable WITHOUT calling getMessages on every chat.
async function loadExisting(client, rooms) {
  const rs = await client.query({
    query: `SELECT session_id, last_updated_at, message_count, extra FROM ${rooms.sessions} FINAL WHERE user_id = currentUser()`,
    format: 'JSONEachRow',
  });
  // Actual message rows per session: an interrupted re-ship (crash between the
  // clear-DELETE and the inserts, or mid-flush on a large transcript) leaves a
  // fresh-looking session row with a missing or PARTIAL transcript — the skip
  // must compare the real row count against the recorded message_count, not
  // merely check that some row exists.
  //
  // countIf(origin='ship'), not count(). message_count records how many rows the
  // SHIPPER wrote; a session that also carries imported rows would never match a
  // plain count(), so `intact` would be false forever and the session would re-ship
  // on every pass — no data lost, but the incremental skip silently stops existing.
  // Measured: adding one origin='import' row to a settled session made it re-ship
  // every pass; removing it froze the session again.
  const mr = await client.query({
    query: `SELECT session_id, countIf(origin = 'ship') AS n FROM ${rooms.messages} FINAL WHERE user_id = currentUser() GROUP BY session_id`,
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
  try { messages = getMessages(chat) || []; }
  catch (e) {
    // Some readers throw instead of reporting through adapter-errors — Cursor's
    // agent-store path on a bad blobs table, for one. Converting that to a bare
    // `unreadable` count would leave the end-of-pass report with nothing to print,
    // so operators would see a number rising every pass and no cause anywhere.
    adapterErrorSink.record(chat.source, e, chat.composerId);
    return null;
  }

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
    const ts = messageTs(chat, seq, total, m);
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
  const rooms = await resolveRooms(client);
  await assertOriginKeyed(client, rooms);
  const existing = await loadExisting(client, rooms);
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
      table: rooms[table],
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
      // _countUnknown means the adapter could not determine this chat's message
      // count, so bubbleCount is a placeholder rather than a measurement. Skipping on
      // it would compare against a number that means nothing — `prev.bc >= 0` is
      // trivially true — and the session would stay stale forever. Re-read instead.
      if (notNewer && !chat._countUnknown && prev.bc >= (chat.bubbleCount || 0) && prev.intact) { skipped++; continue; }
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
    // Write nothing on a failed read, whether or not the session is already stored.
    //
    // Shipping a partial first read looks tempting — nothing is there to destroy —
    // but it is a trap: message_count would be written from the partial rows, so
    // prev.intact becomes true, prev.bc already matches the source, the timestamp is
    // unchanged, and the skip predicate above then withholds the session forever.
    // The truncation would become permanent AND the warning would stop, because the
    // adapter is never asked to read it again. Withholding keeps the session out of
    // the skip predicate entirely, so every pass retries it and re-reports it until
    // the underlying store is readable.
    if (!rows || failedHere) { unreadable++; continue; }
    if (prev) {
      // Known session being re-shipped: clear its old rows BEFORE inserting so a
      // shorter re-parse can't leave stale seq/idx tails. A crash between the
      // delete and the inserts is repaired by the next pass: the skip predicate
      // refuses to skip a non-empty session whose message rows are missing.
      // user_id is BOUND, not `= currentUser()`. A DELETE is a mutation, and a mutation
      // does not necessarily evaluate currentUser() in the caller's context — it matches
      // nothing at all, so the delete silently removes zero rows and the stale tail this
      // code exists to clear survives forever. Measured on ClickHouse 25.11 —
      // the identical predicate with the literal value deleted 2000 rows where
      // currentUser() deleted 0. The value is the same identity either way: it is read
      // from the server over this very connection.
      // origin='ship' is the third bind, and it is not cosmetic. This clear exists so a
      // shorter re-parse cannot leave a stale seq tail behind — but scoped to
      // (session_id, user_id) alone it deletes EVERY row for the session, including rows
      // the adapters did not write and cannot rewrite. Measured, on a real house: an
      // import of 135,307 messages lost 27,948 of them to one ship pass, because
      // memory-house had captured more per session than the adapters emit. The rows the
      // shipper owns are the only rows it may remove.
      for (const t of ['messages', 'tool_calls']) {
        await client.command({
          query: `DELETE FROM ${rooms[t]} WHERE session_id = {id:String} AND user_id = {uid:String} AND origin = 'ship'`,
          query_params: { id, uid: rooms.user },
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
    console.log(`[memhouse] WARNING: ${noBinding.length} adapter(s) skipped, sessions NOT shipped — better-sqlite3 has no native binding: ${noBinding.join(', ')}`);
    console.log('[memhouse]          fix: npm install -g memhouse --allow-scripts=better-sqlite3');
  }
  for (const e of errors.filter((x) => !x.missingBinding)) {
    console.log(`[memhouse] WARNING: ${e.source} skipped — ${e.message}`);
  }
}

// Per-source rollup straight from sessions_v (final=1 so ReplacingMergeTree collapses).
// The rollup resolves like the rooms do — it is a subquery over the caller's own rooms.
async function printStats(client) {
  const rooms = await resolveRooms(client);
  const rs = await client.query({
    query: `
      SELECT source,
             count() AS sessions,
             sum(total_msgs) AS messages,
             sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
      FROM ${rooms.sessions_v}
      GROUP BY source
      ORDER BY sessions DESC`,
    format: 'JSONEachRow',
    clickhouse_settings: READ_SETTINGS,
  });
  const rows = await rs.json();
  if (!rows.length) { console.log('[memhouse] house is empty'); return; }
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
      console.log(`[memhouse] schema ensured (${n} statements)`);
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
    // A failed pass does NOT wait the full interval. The common failure at startup is
    // that the house is not up yet — the container is still booting — and sleeping 300s
    // there means the first ship is
    // five minutes late for a condition that clears in under a second. systemd's
    // After= orders process start, not readiness, and launchd has no ordering at all, so
    // this is the only place the race can be closed for every path at once.
    // Backs off to the normal interval so a genuinely unreachable house is not hammered.
    const RETRY_START_MS = 2000;
    let retryMs = RETRY_START_MS;
    do {
      const t0 = Date.now();
      let failed = false;
      try {
        const r = await runShip(client, { full });
        console.log(`[memhouse] shipped ${r.sessions} sessions (${r.skipped} skipped${r.unreadable ? `, ${r.unreadable} unreadable-will-retry` : ''}) → ` +
          `${r.msgRows} msg rows, ${r.toolRows} tool rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        failed = true;
        // A connection failure arrives as an AggregateError whose own `message` is empty,
        // so this printed "[memhouse] pass failed:" and nothing else, after 35 lines of
        // driver internals. Dig out a cause and name the fix; `status` and `doctor`
        // already handle the same condition cleanly and `ship` was the odd one out.
        const causes = (e && e.errors) ? e.errors.map((x) => x && x.message).filter(Boolean) : [];
        const why = e.message || causes[0] || e.code || String(e);
        console.error(`[memhouse] pass failed: ${why}`);
        if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(why + causes.join(' '))) {
          console.error(`[memhouse] ${process.env.MEMHOUSE_URL} did not answer — is the house running?`);
          console.error('[memhouse] check it with: memhouse doctor');
        }
        if (process.env.MEMHOUSE_DEBUG) console.error(e);
        else console.error('[memhouse] MEMHOUSE_DEBUG=1 for the full error');
        if (!loop) process.exitCode = 1;
      }
      full = false; // --full applies to the first pass only; loop passes stay incremental
      if (loop) {
        const waitMs = failed ? Math.min(retryMs, intervalSec * 1000) : intervalSec * 1000;
        if (failed) {
          console.error(`[memhouse] retrying in ${Math.round(waitMs / 1000)}s`);
          retryMs = Math.min(retryMs * 2, intervalSec * 1000);
        } else {
          retryMs = RETRY_START_MS;
        }
        await new Promise((r) => setTimeout(r, waitMs));
        resetCaches(); // adapters cache chat lists; drop them so new sessions surface
      }
    } while (loop);
  } finally {
    await client.close();
  }
}

module.exports = { runShip, ensureSchema };

if (require.main === module) {
  main().catch((e) => { console.error(`[memhouse] fatal: ${e.message}`); process.exit(1); });
}
