#!/usr/bin/env node
// memhouse SHIPPER — parse-on-client (bet #1 in ../DESIGN.md). Runs the 17 editor
// adapters locally and ships TYPED rows into the house's shared rooms — sessions /
// messages_<m> / tool_calls_<m>, where <m> is `SELECT currentUser()` and never config
// (../house/schema.sql.tpl, ../house/house.js). All of one member's
// machines land in that member's rooms, told apart by the `host` column; no member
// writes into another's. The typed evolution of agency/ingest.js: same host id,
// same ts interpolation, same batching discipline — but rows land in physical
// columns instead of a raw JSON blob.
//
// Data-plane rules (binding, see DESIGN.md):
//   - JSONEachRow, gzip-compressed request body, batches capped at 2000 rows OR ~4 MB
//     (whichever first), async_insert=0 on EVERY insert — the house stamps user_id
//     MATERIALIZED currentUser(), which is empty during async flushes.
//   - DateTime64 values travel as 'YYYY-MM-DD HH:MM:SS.mmm' UTC strings (plain
//     format; ISO 'T'/'Z' forms parse unreliably under JSONEachRow). Nullable → null.
//   - Int64-bound values are integer-coerced (some adapters emit fractional ms).
//   - INSERT-ONLY. The shipper never deletes and never mutates. A re-parse that shrinks
//     or diverges from what is stored is written under a NEW epoch, so the superseded
//     parse survives intact — Claude Code compacts transcripts and deletes them after
//     cleanupPeriodDays (30 by default), which makes the house the only remaining copy.
//     memhouse is an accumulator, not a mirror: absence of a session is never a signal,
//     and no "sync" or "prune" feature may ever be built here.
//   - Re-shipping is always safe: ReplacingMergeTree(ingested_at) collapses to
//     latest-wins at FINAL. Keyed (session_id, user_id, origin, epoch, seq) on messages
//     and (…, epoch, idx) on tool_calls, so an imported row and a shipped one at the same
//     seq are two rows, and so are two parses of the same session. sessions is
//     (session_id, user_id) with NO origin and NO epoch — one metadata row per session is
//     what every read path assumes.
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
// Named, not a raw MODULE_NOT_FOUND with a require stack. This runs as a SUBPROCESS of
// `memhouse ship`/`install`, so its stack trace lands in the middle of the parent's
// output and reads as a crash in the parent. Same preflight provision.js carries.
let createClient, ClickHouseLogLevel;
try { ({ createClient, ClickHouseLogLevel } = require('@clickhouse/client')); }
catch {
  console.error("[memhouse] dependency '@clickhouse/client' is not installed.");
  console.error(`[memhouse] from a checkout:     npm install --prefix ${require('path').join(__dirname, '..', '..')}`);
  console.error(`[memhouse] from an npm install: ${require('../house/house').installCommand()}`);
  process.exit(2);
}
const { getAllChats, getAdapterErrors, getMessages, resetCaches } = require('../../editors');
const adapterErrorSink = require('../../editors/adapter-errors');
const selfUpdate = require('../self-update');
// Captured at require time, which is as close to "what this process booted with" as it
// gets. Taking it later would record whatever an upgrade had already replaced.
const selfSnap = selfUpdate.snapshot(__filename);
const {
  resolveRooms, READ_SETTINGS, ROOM_TYPES, META_TYPES, SCHEMA_VERSION, MEMBER_PIN, createStatement,
  SUPPORTED_SCHEMAS, keyProblem, legacyTextIndexDialect, isTextIndexGrammarRefusal, textIndexDialectFor,
  sessionStatsStatements, sessionModelStatsStatements, sessionToolStatsStatements,
  statTableNames,
} = require('../house/house');
// Rooms plus the house's own record of itself. Every table the template declares, which
// is what the column healer and the drift warning have to cover — a column added to
// events would otherwise roll out to nobody.
const ALL_TABLES = [...ROOM_TYPES, ...META_TYPES];

const BATCH_ROWS = 2000;   // insert batch ceiling by ROW COUNT
// …and by BYTES. A row cap alone let a batch of 2000 wide messages reach ~27 MB, and
// pushing that up through a proxy/tunnel is what dominated insert time (see createClient).
// Flush at whichever ceiling hits first so no single upload is enormous, even uncompressed.
// Override with MEMHOUSE_BATCH_BYTES for a tighter (slow link) or looser (LAN) path.
const BATCH_BYTES = Math.max(256 * 1024, Number(process.env.MEMHOUSE_BATCH_BYTES) || 4 * 1024 * 1024);
const TEXT_MAX = 50000;    // messages.text truncation
const ARGS_MAX = 20000;    // tool_calls.args truncation

// Stable host id: <shorthostname>-<8hex>, where the hex half is a fingerprint written
// ONCE into MEMHOUSE_HOME rather than hashed out of hostname/platform/arch.
//
// The derived version failed in both directions, and both matter here because every
// machine belonging to one member ships into the SAME rooms — `host` is the only column
// separating them. Two laptops answering to the same default hostname produced one id
// between them; renaming a machine moved its id and split its own history. See ../host.js.
function hostId() {
  return require('../host').identity().id;
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

/**
 * Truncate without splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a boundary that lands inside an
 * astral character (emoji, and everything else above U+FFFF) leaves a lone high surrogate
 * at the end. `JSON.stringify` then emits "\ud83d", and ClickHouse rejects THE WHOLE
 * INSERT:
 *
 *   Cannot parse escape sequence: missing second part of surrogate pair
 *   (while reading the value of key text) … CANNOT_PARSE_ESCAPE_SEQUENCE
 *
 * The blast radius is not the one message. One poisoned session among ten made every pass
 * fail and the house stayed completely empty across four passes; under `--loop` it retries
 * forever. In another ordering the failure landed after the sessions insert, leaving
 * session rows whose transcripts do not exist and which accumulated on every pass.
 *
 * Reachable on ordinary data: four messages in a real 398-session history already sit at
 * the 50,000 ceiling, and codex folds a whole turn into one assistant message (mean 9,762
 * chars), so it is the most exposed source. Dropping the orphaned half of a pair costs one
 * character out of 50,000.
 */
function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xD800 && last <= 0xDBFF) ? cut.slice(0, -1) : cut;
}

/**
 * Drop unpaired surrogates from every string on its way into an insert.
 *
 * truncate() above fixes the two places THIS file cuts a string, and that was not enough:
 * the same failure arrives by two other routes.
 *
 *   1. Titles. `cleanPrompt` in editors/claude.js cuts the first prompt to 120 characters,
 *      and 120 is a far more reachable boundary than 50,000. An emoji there produced
 *      `(while reading the value of key name)` — same total outage, different column.
 *   2. Source data. `{"content":"before \ud83d after"}` is valid JSON that JSON.parse
 *      accepts, so a lone surrogate can arrive already in a transcript with no truncation
 *      involved at all.
 *
 * Guarding cut sites one at a time is the wrong shape — every future string field is
 * another instance. This runs over the finished row instead, so nothing reaches ClickHouse
 * carrying an escape it will reject. The cost is one regex over fields that almost never
 * match; the alternative is a member whose house stops accepting rows entirely, exit 1
 * forever under --loop, while `doctor` reports everything green.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function scrub(row) {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'string') {
      if (LONE_SURROGATE.test(v)) { LONE_SURROGATE.lastIndex = 0; row[k] = v.replace(LONE_SURROGATE, ''); }
      LONE_SURROGATE.lastIndex = 0;
    } else if (v && typeof v === 'object') {
      // `extra` is a JSON column; its values travel as strings too.
      row[k] = JSON.parse(JSON.stringify(v).replace(LONE_SURROGATE, ''));
      LONE_SURROGATE.lastIndex = 0;
    }
  }
  return row;
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
    database: process.env.MEMHOUSE_DB || process.env.MEMHOUSE_USER, // house defaults to the user's own name
    // gzip the INSERT body. Measured on a real house behind a Cloudflare tunnel: a
    // 2000-row batch was ~27 MB of JSON and the insert spent 76s in NetworkReceive alone
    // (index build was 0.8s, CPU 1.1s) — the upload, not ClickHouse, was the whole cost.
    // Conversation text compresses ~5-10x, so this turns tens of MB on the wire into a few.
    compression: { request: true },
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

// Create the house's rooms, from ../house/schema.sql.tpl. Comments are
// stripped BEFORE the ';' split — schema comments legitimately contain semicolons.
//
// This is the solo path: on a house you own, `memhouse install` mints your three rooms and
// you are done. It creates nobody else's — the template is rendered for currentUser(), the
// same identity the rooms' user_id is stamped with, so a client cannot name its way into
// someone else's rooms.
//
// It issues no grants: joining a house is the admin's two statements (CREATE USER +
// GRANT ALL ON the house), and once granted, each member's own shipper runs this.
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
/**
 * Refuse, legibly, when the caller's rooms are not there.
 *
 * Without this the first thing to touch a roomless house is loadExisting's SELECT, and the
 * user gets `Unknown table expression identifier 'sessions' in scope SELECT session_id,
 * last_updated_at, message_count, extra FROM ...` — a raw ClickHouse identifier error with
 * no next step, from a command that may be running inside a service loop. `install` and
 * `doctor` both handle the identical situation properly; ship was the one that did not.
 * It is also the documented 0.3.x-upgrade symptom, which INSTALL.md claims is named.
 */
/**
 * The columns each room type declares in the template, as {name, type} — the source of
 * truth for what a room must have. Parsed from the same file that creates them, so a
 * column added there is rolled out without anyone remembering to write a migration.
 *
 * MATERIALIZED and DEFAULT clauses are kept: `user_id String MATERIALIZED currentUser()`
 * has to be added exactly that way or the identity stamp does not happen.
 *
 * The room name in this pattern is the LITERAL table name. It used to be
 * `<type>_{{MEMBER}}`, from the per-member layout, and nobody updated it when the rooms
 * became plain shared tables — so it matched nothing, and every consumer silently got an
 * empty column list. That took out three surfaces at once, all of them reporting success:
 * the column healer in ensureSchema had nothing to add, warnMissingColumns had nothing to
 * warn about, and doctor's column check printed "✓ columns: every room matches the schema
 * template" having compared zero columns. A regression test now pins it (misc/unit-test.js).
 */
function templateColumns(tpl) {
  const out = {};
  for (const t of ALL_TABLES) {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\s*\\(([\\s\\S]*?)\\n\\)`, 'm');
    const m = tpl.match(re);
    if (!m) continue;
    const cols = [];
    let depth = 0, buf = '';
    for (const raw of m[1].split('\n')) {
      const line = raw.replace(/--.*$/, '').trim();
      if (!line) continue;
      buf += (buf ? ' ' : '') + line;
      depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      if (depth > 0 || !buf.endsWith(',')) { if (depth > 0) continue; }
      const decl = buf.replace(/,$/, '').trim();
      buf = '';
      // Skip index/constraint declarations — only column definitions here.
      if (/^(INDEX|CONSTRAINT|PROJECTION|PRIMARY\s+KEY)\b/i.test(decl)) continue;
      const sp = decl.indexOf(' ');
      if (sp < 1) continue;
      cols.push({ name: decl.slice(0, sp), type: decl.slice(sp + 1).trim() });
    }
    out[t] = cols;
  }
  return out;
}

/**
 * Say so, every pass, when a room is missing a column.
 *
 * `ship` does not call ensureSchema — only `--ensure-schema` and `install` do — so a room
 * that has drifted keeps accepting inserts and keeps discarding that field, silently, for
 * as long as nobody thinks to run the healer. Measured: 85 rows shipped with the value
 * thrown away and four surfaces reporting success.
 *
 * A WARNING rather than a refusal: the rows that do fit are still worth having, and
 * refusing would stop all shipping over one column. One extra query per room per pass.
 */
async function warnMissingColumns(client, rooms) {
  let tpl;
  try { tpl = fs.readFileSync(path.join(__dirname, '..', 'house', 'schema.sql.tpl'), 'utf-8'); }
  catch { return; }
  const want = templateColumns(tpl);
  const missing = [];
  for (const t of ALL_TABLES) {
    try {
      const rs = await client.query({
        query: 'SELECT name FROM system.columns WHERE database = currentDatabase() AND table = {n:String}',
        query_params: { n: rooms[`${t}_raw`] }, format: 'JSONEachRow',
      });
      const have = new Set((await rs.json()).map((r) => r.name));
      if (!have.size) continue;
      for (const c of (want[t] || [])) if (!have.has(c.name)) missing.push(`${rooms[`${t}_raw`]}.${c.name}`);
    } catch { /* unreadable rooms are assertRoomsExist's problem */ }
  }
  if (missing.length) {
    console.error(`[memhouse] WARNING: ${missing.length} column(s) missing from your rooms — those fields are being DISCARDED on every pass:`);
    console.error(`[memhouse]   ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` … and ${missing.length - 8} more` : ''}`);
    console.error('[memhouse]   heal them with: memhouse ship --ensure-schema');
  }
}

async function assertRoomsExist(client, rooms) {
  const rs = await client.query({
    query: `SELECT name FROM system.tables WHERE database = currentDatabase() AND name IN ({n:Array(String)})`,
    query_params: { n: ROOM_TYPES.map((t) => rooms[`${t}_raw`]) },
    format: 'JSONEachRow',
  });
  const have = new Set((await rs.json()).map((r) => r.name));
  const missing = ROOM_TYPES.map((t) => rooms[`${t}_raw`]).filter((n) => !have.has(n));
  if (!missing.length) return;
  throw new Error(
    `'${rooms.member}' has no ${missing.join(', ')} in this house.\n`
    + '  Create them:  memhouse install\n'
    + '  If you hold no CREATE TABLE here, the owner runs:\n'
    + `    memhouse install --print-sql --member ${rooms.member}\n`
    + '  A house from before 0.4 reaches this too — its rooms have different names.');
}

/**
 * Refuse to write into rooms whose sorting key is not the one the shipper's safety
 * depends on. What each column buys is written out on ROOM_KEYS in ../house/house.js;
 * this is the enforcement, run at the top of EVERY pass rather than only in
 * `--ensure-schema`, because a plain `memhouse ship` never calls ensureSchema and a guard
 * living only there is a guard that never runs on the path that does the damage.
 */
async function assertRoomKeys(client, rooms) {
  const wrong = [];
  for (const t of ROOM_TYPES) {
    const rs = await client.query({
      query: `SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = {n:String}`,
      query_params: { n: rooms[`${t}_raw`] }, format: 'JSONEachRow',
    });
    const row = (await rs.json())[0];
    // A room that does not exist at all is assertRoomsExist's job and is reported there.
    if (!row) continue;
    const problem = keyProblem(t, row.sorting_key);
    if (problem) wrong.push(`${rooms[`${t}_raw`]} ${problem}`);
  }
  if (wrong.length) {
    throw new Error(
      'this house needs a one-time migration before it can be shipped to. Run:\n'
      + '\n    memhouse migrate\n'
      + '\n  (an upgrade from a pre-0.10 memhouse cannot prompt for this itself — the old\n'
      + '  `update` command predates migrations, so run the line above once, by hand.)\n'
      + '\n  Why: these rooms have the wrong sorting key, so a ship pass would corrupt them:\n'
      + wrong.map((s) => `    ${s}`).join('\n')
      + '\n  ORDER BY cannot be altered in place, so migrate copies each room into one with\n'
      + '  the current key, swaps them atomically, and keeps the old one as <room>_pre_epoch\n'
      + '  for you to drop. Nothing is deleted.');
  }
}

// The shipper reads the prefix straight from its environment: it is spawned with the
// resolved MEMHOUSE_* env by the CLI, and every room name it touches comes from
// resolveRooms, so this is the only line that needs to know.

async function ensureSchema(client) {
  const rooms = await resolveRooms(client);
  // BEFORE the CREATEs and ALTERs, not beside the end-of-function asserts. A house whose
  // record says a newer release moved it forward may have columns this template does not
  // know; running this template's DDL first could add back what that release removed —
  // the exact write the guard exists to prevent.
  await assertNotLegacyLayout(client, rooms);
  await assertWriterSupported(client, rooms);
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'house', 'schema.sql.tpl'), 'utf-8');
  // Rendered per room rather than taken as one blob, because a prefixed house names its
  // rooms `<prefix>_messages` and the template says `messages`. With no prefix the two
  // are identical, so this is the same statements in the same order as before.
  const stmts = [...ROOM_TYPES, ...META_TYPES]
    .map((t) => createStatement(tpl, t, rooms.physical ? rooms.physical[t] : t)
      .replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
  // Two failure shapes are survivable here and both are skipped rather than fatal:
  //
  //   - a permission denial. A read-only credential can still run --ensure-schema for
  //     its ADD COLUMN rollout; ClickHouse checks the grant BEFORE existence, so IF NOT
  //     EXISTS does not save the CREATEs. Skip what we may not do and carry on.
  //   - a create RACE. Two housemates' first-ever ships can run these CREATEs
  //     concurrently, and IF NOT EXISTS is not atomic against a simultaneous creator —
  //     the loser can get TABLE_ALREADY_EXISTS or a metadata-file collision. The table
  //     exists either way, which is the outcome this function wants.
  let denied = 0;
  // The text-index grammar changed at 25.10 and neither side parses the other (measured:
  // 25.8/25.9 take the quoted form, 25.10+ the function form). Pick by the server's own
  // version, then keep one fallback: if the chosen form is refused on grammar alone —
  // never on privilege — send the other. A wrong guess costs a round-trip, not the install.
  const version = await serverVersion(client);
  const dialect = textIndexDialectFor(version);
  if (dialect === 'legacy') console.error(`[memhouse] ClickHouse ${version}: text indexes in the pre-25.10 grammar`);
  const create = (q) => client.command({ query: q, clickhouse_settings: { async_insert: 0, allow_experimental_full_text_index: 1 } });
  for (const modern of stmts) {
    const legacy = legacyTextIndexDialect(modern);
    const [first, second] = dialect === 'legacy' ? [legacy, modern] : [modern, legacy];
    try {
      try { await create(first); }
      catch (e) {
        const m = e && e.message ? e.message : String(e);
        if (!(first !== second && isTextIndexGrammarRefusal(m))) throw e;
        await create(second);
      }
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      if (/Not enough privileges|ACCESS_DENIED/i.test(m)) { denied++; continue; }
      if (/ALREADY_EXISTS|already exists/i.test(m)) { continue; } // lost a create race — the winner made it
      throw e;
    }
  }
  // The precomputed rollups — additive, so they belong here and not in a migration (see
  // migrate.js's rule). Three plain tables plus the refreshable views that fill them;
  // the read layer probes for them at startup and falls back to the inline rollup when
  // they are absent, so a denied CREATE here degrades to slow, never to wrong. Built from
  // the SAME rollup text the read layer would otherwise run, so the two cannot drift.
  const statStmts = [
    ...sessionStatsStatements(rooms), ...sessionModelStatsStatements(rooms), ...sessionToolStatsStatements(rooms),
  ];
  for (const q of statStmts) {
    try {
      await client.command({
        query: q,
        // 26.x defaults the flag on; 25.x wants it stated. Query-scoped, like the
        // text-index flag above.
        clickhouse_settings: { async_insert: 0, allow_experimental_refreshable_materialized_view: 1 },
      });
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      if (/Not enough privileges|ACCESS_DENIED/i.test(m)) { denied++; continue; }
      if (/ALREADY_EXISTS|already exists/i.test(m)) { continue; }
      throw e;
    }
  }
  // Kick the first population now rather than waiting for the schedule: a refreshable
  // view's first refresh lands at its next interval boundary, and until then the read
  // layer (correctly) ignores the empty table and runs the slow rollup. Best effort —
  // the schedule gets there on its own, this just makes install/update fast at once.
  for (const mv of Object.values(statTableNames(rooms.member)).map((t) => `${t}_mv`)) {
    try { await client.command({ query: `SYSTEM REFRESH VIEW ${mv}` }); } catch { /* no grant, or not there */ }
  }
  if (denied) {
    // In a SHARED house this is the designed state, not a shortfall: the operator creates
    // each member's rooms during `invite` precisely so the member cannot — a member who
    // could CREATE TABLE here could add tables beside every housemate's. Saying "you do
    // not hold these rights" and then "schema ensured" about the same statements reads as
    // a contradiction on every routine ship, which is how often a member sees it.
    // A member holds CREATE TABLE on their own name pattern, so this is no longer the
    // ordinary path — it is a credential provisioned outside memhouse with less than the
    // plan gives. Say what to ask for rather than whose job it is.
    console.error(`[memhouse] ${denied} schema statement(s) needed rights this credential does not hold — continuing with what it can do.`);
    console.error('[memhouse] the memhouse grant is one line — `memhouse install --print-sql` shows it; ask whoever administers the house to run it.');
  }
  // A house created before origin existed has no such column, and every read and write
  // scopes by it. Add it in place; ReplacingMergeTree backfills the DEFAULT, so every
  // pre-existing row reads as 'ship', which is what it was. (Having the COLUMN is not
  // having it in the sorting KEY — that is assertRoomKeys' refusal and migrate-rooms'
  // job, because ORDER BY cannot be altered.)
  //
  // EVERY column the template declares, not just `origin`.
  //
  // This used to add exactly one column, which meant any OTHER column missing from a room
  // was invisible and lossy: `ship` writes the row, ClickHouse discards the field it has
  // no column for, and the pass reports success. Measured — a room with `is_subagent`
  // dropped shipped 85 rows with the value silently thrown away, while `ship`, `install`,
  // `--ensure-schema` AND `doctor` all reported green. doctor's schema check counts ROOMS,
  // not columns, so nothing anywhere noticed.
  //
  // It also made the grant a lie: rooms.js and INSTALL.md both say ALTER ADD COLUMN is
  // granted "for ensureSchema's rollout", and no rollout of anything but `origin` existed.
  const wantCols = templateColumns(tpl);
  for (const t of ALL_TABLES) {
    let have = new Set();
    try {
      const rs = await client.query({
        query: 'SELECT name FROM system.columns WHERE database = currentDatabase() AND table = {n:String}',
        query_params: { n: rooms[`${t}_raw`] }, format: 'JSONEachRow',
      });
      have = new Set((await rs.json()).map((r) => r.name));
    } catch { /* unreadable: the checks above already reported why */ }
    // No columns means the table is not there — the CREATEs above were denied, or this is
    // a house where the meta tables were never created. ALTERing it would throw
    // UNKNOWN_TABLE, which is not a permissions error and so prints, once per column, on
    // every `--ensure-schema`. Nothing to heal on a table that does not exist.
    if (!have.size) continue;
    for (const col of (wantCols[t] || [])) {
      if (have.has(col.name)) continue;
      try {
        await client.command({
          query: `ALTER TABLE ${rooms[`${t}_raw`]} ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
          clickhouse_settings: { allow_experimental_full_text_index: 1 },
        });
        console.log(`[memhouse] added missing column ${rooms[`${t}_raw`]}.${col.name}`);
      } catch (e) {
        const m = e && e.message ? e.message : String(e);
        if (!/Not enough privileges|ACCESS_DENIED/i.test(m)) {
          console.error(`[memhouse] could not add ${rooms[`${t}_raw`]}.${col.name}: ${m}`);
        }
      }
    }
  }
  // There used to be a second, hardcoded `ADD COLUMN … origin` here, from when the healer
  // above could only add that one column. It is redundant now that the generic loop reads
  // the template correctly — and it would have been actively wrong once this loop covered
  // meta and events, which have no origin and want none.

  await assertRoomsExist(client, rooms);
  await assertRoomKeys(client, rooms);
  await warnMissingColumns(client, rooms);
  // Re-assert the async-insert pin. A 0.11 member holds ALTER USER on themselves (so
  // `memhouse passwd` needs no admin) — and that same grant lets them drop the pin
  // (`ALTER USER <self> SETTINGS NONE`), which on some ClickHouse versions makes their
  // OWN async inserts land with an empty user_id. It cannot forge another identity
  // (currentUser() is server-side) and doctor flags any blank user_id, but re-adding the
  // pin here means an accidental or transient drop self-heals on the next --ensure-schema
  // (install, update, migrate). Best-effort: a member who cannot ADD SETTING just stays
  // as they were.
  try { await client.command({ query: `ALTER USER \`${rooms.user}\` ADD SETTING ${MEMBER_PIN}`, clickhouse_settings: { async_insert: 0 } }); }
  catch { /* no self-alter grant (pre-0.11), or not permitted — leave it */ }
  // The rooms are at this schema generation — the assertion above is what makes that a
  // fact rather than a claim. Recording it here means a house built by `install` is
  // already stamped, instead of looking un-migrated until its first ship pass.
  //
  // MEMHOUSE_NO_RECORD is the invite path: `memhouse invite` runs this only to PROVE the
  // new member can build the rooms, on a throwaway home. Recording would stamp a phantom
  // <member>@<ephemeral-host> writer into a house the inviter never ships to — the
  // invitee mints their real identity on their own first pass.
  if (process.env.MEMHOUSE_NO_RECORD !== '1') await recordHouseState(client, rooms, hostId());
  return stmts.length;
}

/**
 * Keep the house's record of itself current: which schema generation it is at, and which
 * memhouse version is writing into it.
 *
 * Written only when something CHANGED. A row per pass would turn events into a
 * heartbeat log — under `--loop` at the default interval that is 288 rows a day per
 * machine, and the one question the table exists to answer ("when did this house move,
 * and who moved it") would be buried in noise.
 *
 * Entirely best-effort. A member on someone else's house may hold no rights on these
 * tables, or the house may predate them; none of that is a reason to stop shipping, so
 * every failure here is swallowed. The rooms are the product, this is the paperwork.
 */
async function recordHouseState(client, rooms, host) {
  const version = require('../../package.json').version;
  const writer = `${rooms.user}@${host}`;
  try {
    const rs = await client.query({
      query: `SELECT key, value FROM ${rooms.meta} FINAL WHERE key IN ('schema_version', {ck:String}, {cs:String})`,
      // Keyed per member AND host. Keyed by member alone, two machines of one member
      // overwrote each other's entry on every pass, so the fleet view could only ever
      // show the machine that shipped last — the exact machine that needs no attention.
      query_params: { ck: `client_version:${writer}`, cs: `client_schema:${writer}` }, format: 'JSONEachRow',
    });
    const have = new Map((await rs.json()).map((r) => [r.key, String(r.value)]));
    const events = [];
    const metas = [];
    if (have.get('schema_version') !== String(SCHEMA_VERSION)) {
      // The rooms are at this generation — assertRoomKeys ran before this and refuses to
      // let a pass reach here otherwise, so recording it is a statement of fact, not a
      // claim about what someone intends to do.
      metas.push({ key: 'schema_version', value: String(SCHEMA_VERSION), host });
      events.push({
        kind: 'schema', status: 'observed', host,
        from_version: have.get('schema_version') || '', to_version: String(SCHEMA_VERSION),
        detail: 'rooms carry the current sorting keys',
      });
    }
    const clientKey = `client_version:${writer}`;
    // The schema this writer SUPPORTS, beside the marketing version — the fleet view
    // judges on this, because a version string cannot be compared against a schema
    // requirement (and a pre-release checkout may not have bumped package.json at all).
    // Tracked on its own change, not the version's: tying it to a version bump left every
    // already-recorded writer without one forever.
    const mySchema = String(Math.max(...SUPPORTED_SCHEMAS));
    if (have.get(`client_schema:${writer}`) !== mySchema) {
      metas.push({ key: `client_schema:${writer}`, value: mySchema, host });
    }
    if (have.get(clientKey) !== version) {
      metas.push({ key: clientKey, value: version, host });
      events.push({
        kind: 'version', status: 'observed', host,
        from_version: have.get(clientKey) || '', to_version: version,
        detail: `${rooms.user} shipping from ${host}`,
      });
    }
    // The heartbeat, EVERY pass — the fleet view's health column. Latest-wins on the key,
    // so it is one live row per writer however often it fires; version/schema above stay
    // change-only so events remains a record of moves, not a pulse trace.
    metas.push({ key: `last_ship:${writer}`, value: new Date().toISOString(), host });
    await client.insert({
      table: rooms.meta_raw, values: metas, format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 0 },
    });
    if (events.length) {
      await client.insert({
        table: rooms.events_raw, values: events, format: 'JSONEachRow',
        clickhouse_settings: { async_insert: 0 },
      });
    }
  } catch { /* the house's paperwork is never worth failing a pass over */ }
}

/**
 * The forward half of the compatibility story: refuse a house whose RECORDED schema this
 * release does not support, before any room is touched.
 *
 * Distinct from assertRoomKeys, which inspects key SHAPES — a future generation could be
 * a data transform the keys do not show. This reads what the house says about itself:
 * meta['schema_version'] (what generation the rooms are at) and
 * meta['min_writer_schema'] (the floor `memhouse migrate` sets under writers).
 * Too new -> the fix is on THIS machine: memhouse update. Below the floor -> same.
 * (A house OLDER than this release is not an error here — the room checks catch it and
 * name `memhouse migrate`; this guard must not fire on a pre-0.10 house that has no
 * record at all.)
 *
 * Releases before 0.10.0 never read this — for them the floor is enforced by the
 * pilot's GRANTs, not by code.
 */
/**
 * A house from before the one-layout holds plain rooms — `messages`, not `<member>_messages`.
 * Shipping into it would quietly create a second, empty set of rooms beside the full ones
 * and write there: every past session invisible to the member's own reads, the dashboard
 * and the skills, with nothing anywhere saying why. Refuse, and say exactly what moves the
 * old rooms across — a RENAME, instant, nothing copied.
 *
 * Trips only when the member's rooms are ABSENT and the plain ones PRESENT; a house holding
 * both is mid-conversion and is left alone.
 */
async function serverVersion(client) {
  try {
    const rs = await client.query({ query: 'SELECT version() AS v', format: 'JSONEachRow' });
    return String(((await rs.json())[0] || {}).v || '');
  } catch { return ''; }
}

async function assertNotLegacyLayout(client, rooms) {
  const rs = await client.query({
    query: `SELECT name FROM system.tables WHERE database = currentDatabase() AND name IN ('messages', '${rooms.physical.messages}')`,
    format: 'JSONEachRow',
  });
  const names = new Set((await rs.json()).map((r) => r.name));
  if (names.has(rooms.physical.messages) || !names.has('messages')) return;
  // The plain rooms of a pre-one-layout house: the transcript rooms by type name, and the
  // two bookkeeping rooms under the names they had then.
  const legacyName = { meta: 'house_meta', events: 'house_events' };
  const moves = [...ROOM_TYPES, ...META_TYPES].map((t) => `RENAME TABLE ${legacyName[t] || t} TO ${rooms.physical[t]};`).join('\n     ');
  throw new Error(
    'this house holds plain rooms (messages, sessions, tool_calls) — the layout before rooms were named for their member.\n'
    + `  Shipping now would create empty ${rooms.pattern} rooms beside them and write there, hiding every past session.\n`
    + `  Move the old rooms across (a rename — instant, nothing copied), then ship again:\n     ${moves}\n`
    + `  Then replace the database-wide grant with the one-layout grant:  memhouse install --print-sql --member ${rooms.member}`);
}

async function assertWriterSupported(client, rooms) {
  let have;
  try {
    const rs = await client.query({
      query: `SELECT key, value FROM ${rooms.meta} FINAL WHERE key IN ('schema_version', 'min_writer_schema')`,
      format: 'JSONEachRow',
    });
    have = new Map((await rs.json()).map((r) => [r.key, toInt(r.value)]));
  } catch (e) {
    // ONLY a missing table means a pre-0.10 house (the room checks own that case). Any
    // other failure — an ACCESS_DENIED on meta, a timeout — used to fall through
    // here too, and a writer that merely could not READ the record was treated as if the
    // record did not exist: on a newer-schema house whose key shapes happen to match,
    // that bypassed the whole compatibility guard. Not being able to check is a reason
    // to refuse, never a reason to proceed.
    const m = e && e.message ? e.message : String(e);
    if (/UNKNOWN_TABLE|Unknown table expression|doesn't exist|does not exist/i.test(m)) return;
    throw new Error(`could not read this house's compatibility record (${m.split('\n')[0]})\n`
      + '  Refusing to write until it is readable — a writer that cannot check the schema\n'
      + '  generation must not assume it matches.');
  }
  const houseSchema = have.get('schema_version') || 0;
  const floor = have.get('min_writer_schema') || 0;
  const mine = Math.max(...SUPPORTED_SCHEMAS);
  // MEMBERSHIP, not a ceiling. `houseSchema <= max` would let a [4]-only writer into a
  // schema-3 house — and if generation 4 was a data transform, the sorting keys match and
  // nothing else refuses. A recorded generation this release does not list is unwritable
  // in either direction; only the remedy differs.
  if (houseSchema > 0 && !SUPPORTED_SCHEMAS.includes(houseSchema)) {
    throw new Error(houseSchema > mine
      ? `this house is at schema ${houseSchema}; this memhouse (${require('../../package.json').version}) supports ${SUPPORTED_SCHEMAS.join(', ')}.\n`
        + '  A newer release moved the house forward. Writing with this one could corrupt it, so it will not.\n'
        + '  Update THIS machine:  memhouse update'
      : `this house is at schema ${houseSchema}; this memhouse supports ${SUPPORTED_SCHEMAS.join(', ')}.\n`
        + '  Bring the house forward:  memhouse migrate');
  }
  if (floor > mine) {
    throw new Error(
      `this house requires writers at schema ${floor}+; this memhouse supports ${SUPPORTED_SCHEMAS.join(', ')}.\n`
      + '  Update THIS machine:  memhouse update');
  }
}

// Incremental state: what the house already holds, keyed by session_id. We compare
// against extra.bubbleCount (the adapter's own cheap count, stored at ship time) —
// NOT message_count — because parsed-message count and bubbleCount are different
// units in several adapters (claude folds subagents, codex reports 0), and skipping
// must be decidable WITHOUT calling getMessages on every chat.
async function loadExisting(client, rooms) {
  const rs = await client.query({
    query: `SELECT session_id, last_updated_at, message_count, extra FROM ${rooms.sessions_raw} FINAL WHERE user_id = currentUser()`,
    format: 'JSONEachRow',
  });
  // Actual message rows per session: an interrupted re-ship (a crash mid-flush on a
  // large transcript, or between the sessions insert and the messages one) leaves a
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
  //
  // GROUPED BY EPOCH, and only the newest epoch's rows count. A session whose parse was
  // superseded still holds every older parse — that is the point of the epoch — so a
  // plain count would exceed message_count forever, `intact` would never be true, and the
  // incremental skip would quietly stop existing for exactly the sessions that have been
  // through a compaction. One row per (session, epoch); epochs are rare, so this stays
  // the same size as the per-session grouping it replaces.
  const mr = await client.query({
    query: `SELECT session_id, epoch, count() AS n, max(seq) AS max_seq FROM ${rooms.messages_raw} FINAL
            WHERE user_id = currentUser() AND origin = 'ship' GROUP BY session_id, epoch`,
    format: 'JSONEachRow',
  });
  // Kept PER EPOCH, not collapsed to each room's own newest — a room can legitimately
  // have no rows at the session's current epoch, and reading its highest epoch instead
  // would answer with the superseded parse. See the tool_calls note below, which is where
  // that actually bites.
  //
  // U+0000 as the key separator, and written as an ESCAPE, deliberately. A session_id is
  // '<source>:<adapter-local id>' and an adapter-local id can legally contain any
  // printable character, so only a byte that cannot appear in one is collision-proof.
  // The escape matters twice over: a literal NUL byte typed here once made grep treat
  // this file as binary — and one of the three key sites was typed with a plain space
  // instead, so the tool lookups missed on every call, `tools.n` read 0, every session
  // with tool calls failed `intact`, and a real 437-session history re-shipped 324
  // sessions on EVERY pass, forever, with every surface green. All three sites must
  // build this key identically; the unit test pins them to each other.
  const at = (m, id, epoch) => m.get(`${id}\u0000${epoch}`) || null;
  const msgState = new Map();     // (session, epoch) → { n, maxSeq }
  const msgEpoch = new Map();     // session → newest epoch present
  for (const r of await mr.json()) {
    const epoch = toInt(r.epoch);
    msgState.set(`${r.session_id}\u0000${epoch}`, { n: toInt(r.n), maxSeq: toInt(r.max_seq) });
    msgEpoch.set(r.session_id, Math.max(epoch, msgEpoch.get(r.session_id) || 0));
  }
  // The tool_calls room needs the same check, and used to have none. shipSession writes
  // sessions, then messages, then tool_calls — so a pass that fails during the LAST of
  // those three leaves a session whose message count matches perfectly. The next pass
  // reads that as intact, skips it, and the tool calls are never written. Not a crash:
  // exit 0, `status` and `stats` both green, and only `ship --full` ever recovers them.
  // Reproduced by dropping the room mid-pass; any transient — a ClickHouse restart, a
  // quota rejection, a network blip — reaches the same state.
  const tr = await client.query({
    query: `SELECT session_id, epoch, count() AS n, max(idx) AS max_idx FROM ${rooms.tool_calls_raw} FINAL
            WHERE user_id = currentUser() AND origin = 'ship' GROUP BY session_id, epoch`,
    format: 'JSONEachRow',
  });
  const toolState = new Map();    // (session, epoch) → { n, maxIdx }
  const toolEpoch = new Map();    // session → newest epoch present
  for (const r of await tr.json()) {
    const epoch = toInt(r.epoch);
    toolState.set(`${r.session_id}\u0000${epoch}`, { n: toInt(r.n), maxIdx: toInt(r.max_idx) });
    toolEpoch.set(r.session_id, Math.max(epoch, toolEpoch.get(r.session_id) || 0));
  }
  const map = new Map();
  for (const r of await rs.json()) {
    // DateTime64 comes back as 'YYYY-MM-DD HH:MM:SS.mmm' — re-parse as UTC.
    const ms = r.last_updated_at ? Date.parse(r.last_updated_at.replace(' ', 'T') + 'Z') : null;
    const bc = toInt(r.extra && r.extra.bubbleCount);
    const count = toInt(r.message_count);
    // Sessions shipped before toolCallCount existed read 0 here, so any of them that do
    // have tool calls re-ship exactly once and then record it. Self-correcting, and
    // cheaper than a branch that has to be remembered forever.
    const toolCount = toInt(r.extra && r.extra.toolCallCount);
    // The session's current epoch is whatever its ROWS say, never what the sessions row
    // says: sessions is latest-wins with no origin in its key, so an import writing that
    // row after a bump would hand the next pass a 0 and make it overwrite the current
    // parse. The column there is for people, not for this.
    const epoch = Math.max(msgEpoch.get(r.session_id) || 0, toolEpoch.get(r.session_id) || 0);
    // Everything else is read AT that epoch, and "no rows there" means zero — not "look
    // at the newest epoch this room happens to have".
    //
    // Getting this wrong does not lose data, it makes the shipper churn forever. A parse
    // that keeps its messages but drops every tool call writes nothing into tool_calls at
    // the new epoch. Reading that room's own newest epoch then returned the SUPERSEDED
    // count (say 2) and its maxIdx — so `intact` compared 2 against the recorded 0 and was
    // false on every pass, and decideEpoch compared `0 - 1 < oldMaxIdx` and bumped again
    // on every pass. The session re-shipped and gained an epoch forever, growing the house
    // without end, while every surface reported success.
    const msgs = at(msgState, r.session_id, epoch) || { n: 0, maxSeq: -1 };
    const tools = at(toolState, r.session_id, epoch) || { n: 0, maxIdx: -1 };
    const intact = msgs.n === count && tools.n === toolCount;
    map.set(r.session_id, {
      ms, count, bc, intact, epoch,
      maxSeq: msgs.maxSeq,
      maxIdx: tools.maxIdx,
      hasRows: msgEpoch.has(r.session_id) || toolEpoch.has(r.session_id),
    });
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
    const text = truncate(raw, TEXT_MAX);
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
        args: truncate(args, ARGS_MAX),
        ts,
        project,
        folder,
      });
    }
  }
  // What a complete ship of this session looks like, recorded ON the session row so the
  // next pass can tell "finished" from "got part way". message_count already carries the
  // message half; without the tool half a pass that dies between the messages insert and
  // the tool_calls insert leaves a session that looks finished forever. See loadExisting.
  session.extra.toolCallCount = toolRows.length;
  return { session, msgRows, toolRows };
}

/**
 * Which parse epoch this re-ship belongs to, and why.
 *
 * THE RULE: the shipper never writes over stored content that differs from what it is
 * writing. If the new parse can be laid on top of the old one without changing or
 * orphaning anything, it reuses the epoch and ReplacingMergeTree dedupes it exactly as
 * before — the common case, free. Otherwise it moves to a new epoch, where the new rows
 * cannot collide with the old ones, and the old parse stays whole.
 *
 * Two things make a parse un-overwritable, and both are ordinary:
 *
 *   SHRINK. A re-parse with fewer messages leaves the old higher-seq rows with nothing
 *   written over them. That stale tail is what the DELETE this replaces was written to
 *   remove — and the delete could not tell a fixed adapter bug (junk, worth removing)
 *   from a compacted or user-deleted transcript (irreplaceable), because from outside
 *   they look identical.
 *
 *   DIVERGENCE. Claude Code COMPACTS a session in place: same session, rewritten
 *   shorter, with different content at low seq numbers. Bumping on shrink alone would
 *   preserve the tail and still overwrite the rewritten head — the same loss, reached
 *   through the merge instead of the delete. line_hash is already stored per row, so
 *   comparing is a lookup, not a re-read of the source.
 *
 * Tool calls carry no hash, so they are compared on (tool_name, args) directly. They are
 * derived from `m._toolCalls`, which can change while the assistant text does not.
 *
 * Pure, and exported: this is the decision the whole redesign rests on, and it is unit
 * tested without a server.
 *
 * @param {object|null} stored  { epoch, maxSeq, maxIdx, hashes: Map<seq,string>,
 *                                tools: Map<idx,{tool_name,args}> } — null when the
 *                                session is not in the house yet.
 * @param {object} incoming     { msgRows, toolRows } as built by rowsForChat.
 * @returns {{ epoch: number, reason: string|null }} reason is null when nothing moved.
 */
function decideEpoch(stored, incoming) {
  if (!stored) return { epoch: 0, reason: null };
  const epoch = toInt(stored.epoch);
  const bump = (reason) => ({ epoch: epoch + 1, reason });

  const maxSeq = Number.isFinite(stored.maxSeq) ? stored.maxSeq : -1;
  const maxIdx = Number.isFinite(stored.maxIdx) ? stored.maxIdx : -1;
  if (incoming.msgRows.length - 1 < maxSeq) {
    return bump(`${maxSeq + 1} messages stored, ${incoming.msgRows.length} parsed`);
  }
  if (incoming.toolRows.length - 1 < maxIdx) {
    return bump(`${maxIdx + 1} tool calls stored, ${incoming.toolRows.length} parsed`);
  }

  // A seq the house does not hold is a gap, not a disagreement — there is nothing there
  // to destroy, so it is not a reason to fork the session.
  const hashes = stored.hashes || new Map();
  for (const row of incoming.msgRows) {
    if (row.seq > maxSeq) break;
    const was = hashes.get(row.seq);
    if (was !== undefined && was !== String(row.line_hash)) {
      return bump(`message ${row.seq} was rewritten`);
    }
  }
  const tools = stored.tools || new Map();
  for (const row of incoming.toolRows) {
    if (row.idx > maxIdx) break;
    const was = tools.get(row.idx);
    if (was !== undefined && (was.tool_name !== row.tool_name || was.args !== row.args)) {
      return bump(`tool call ${row.idx} was rewritten`);
    }
  }
  return { epoch, reason: null };
}

/**
 * What the house currently holds for ONE session, at its current epoch — the input
 * decideEpoch needs to tell an append from a rewrite.
 *
 * Read only for sessions actually being re-shipped, which the incremental skip has
 * already narrowed to a handful; it replaces the two DELETE mutations that used to run
 * per re-shipped session, so a normal pass does strictly less work than before.
 *
 * `toString(line_hash)`: the client is configured with
 * output_format_json_quote_64bit_integers = 0, so a UInt64 arrives as a JSON number and
 * everything above 2^53 comes back rounded. Comparing rounded hashes would report
 * divergence on identical rows and fork a session on every single pass.
 */
async function loadStoredParse(client, rooms, id, uid, epoch) {
  const params = { id, uid, e: epoch };
  const mr = await client.query({
    query: `SELECT seq, toString(line_hash) AS line_hash FROM ${rooms.messages_raw} FINAL
            WHERE session_id = {id:String} AND user_id = {uid:String} AND origin = 'ship' AND epoch = {e:UInt32}`,
    query_params: params, format: 'JSONEachRow',
  });
  const hashes = new Map();
  for (const r of await mr.json()) hashes.set(toInt(r.seq), String(r.line_hash));
  const tr = await client.query({
    query: `SELECT idx, tool_name, args FROM ${rooms.tool_calls_raw} FINAL
            WHERE session_id = {id:String} AND user_id = {uid:String} AND origin = 'ship' AND epoch = {e:UInt32}`,
    query_params: params, format: 'JSONEachRow',
  });
  const tools = new Map();
  for (const r of await tr.json()) tools.set(toInt(r.idx), { tool_name: r.tool_name, args: r.args });
  return { hashes, tools };
}

// One shipping pass. Incremental unless opts.full: a chat is skipped when the house
// already has it at least as fresh (last_updated_at) and at least as large
// (extra.bubbleCount) — both readable without parsing the chat.
async function runShip(client, opts = {}) {
  const { full = false } = opts;
  const host = hostId();
  // Always load what the house holds — even with --full. The skip decision uses it only
  // in incremental mode, but re-shipping a KNOWN session needs its current epoch and row
  // shape: writing at the wrong epoch either forks a session that did not change, or
  // overwrites a stored parse that did.
  const rooms = await resolveRooms(client);
  await assertNotLegacyLayout(client, rooms);
  await assertWriterSupported(client, rooms);
  await assertRoomsExist(client, rooms);
  await assertRoomKeys(client, rooms);
  await warnMissingColumns(client, rooms);
  await recordHouseState(client, rooms, host);
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
  const batchBytes = { sessions: 0, messages: 0, tool_calls: 0 };
  const flush = async (table) => {
    if (!batches[table].length) return;
    await client.insert({
      table: rooms[`${table}_raw`],
      values: batches[table],
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 0 }, // binding: user_id stamping breaks otherwise
    });
    batches[table] = [];
    batchBytes[table] = 0;
  };
  const push = async (table, row) => {
    batches[table].push(row);
    // Accumulate the serialized size so a few very wide rows (a 50k-char message) flush the
    // batch as readily as 2000 small ones. The client re-serializes on insert; this extra
    // stringify is trivial next to the network time it exists to bound.
    batchBytes[table] += Buffer.byteLength(JSON.stringify(row));
    if (batches[table].length >= BATCH_ROWS || batchBytes[table] >= BATCH_BYTES) await flush(table);
  };

  const seen = new Set(); // adapters must not double-ship a session id within a pass
  let sessions = 0, skipped = 0, msgRows = 0, toolRows = 0, unreadable = 0, bumped = 0, withheld = 0;
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
    // swallows its own failure returns [] instead, which would look like a session that
    // genuinely has no messages — and for a known session that is a maximal shrink, so
    // the pass would fork it to a new, EMPTY epoch and every read would show nothing
    // where a transcript used to be. Nothing is destroyed any more, but a house that
    // reports empty sessions after a locked SQLite file is still wrong. So treat a
    // failure recorded while reading THIS chat as unreadable: write nothing, retry next
    // pass.
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

    // A KNOWN session that now parses to nothing is withheld, not written.
    //
    // Two reasons, and the second is the one that bites. An adapter that swallows its own
    // failure returns [] rather than throwing, which is indistinguishable from a chat
    // whose content really did vanish — and the house is the party that still has the
    // content either way. Worse, writing it would not even be honest about itself: with
    // zero rows to insert, the new epoch exists nowhere in the room, so the read filter's
    // max(epoch) would keep answering with the SUPERSEDED epoch and serve the old parse as
    // if it were current. Withholding leaves the session out of the skip predicate, so
    // every pass retries it and says so.
    if (prev && prev.hasRows && !rows.msgRows.length) {
      withheld++;
      console.log(`[memhouse] WARNING: ${id} parsed to 0 messages but the house holds ${prev.count} — withholding`);
      continue;
    }

    // Which parse this belongs to. A known session whose stored rows the new parse
    // cannot be laid over — shorter, or rewritten at an overlapping position — moves to
    // a new epoch instead of overwriting anything. See decideEpoch.
    //
    // This is where a DELETE used to be. It removed the session's shipped rows before
    // re-inserting them, which is the only way to clear a stale seq tail in a
    // ReplacingMergeTree — and it destroyed content that existed nowhere else, because
    // Claude Code compacts transcripts and deletes them after cleanupPeriodDays (30 by
    // default), so a shorter re-parse is at least as likely to mean "the source lost it"
    // as "the adapter was fixed". The house is supposed to outlive the source.
    let epoch = 0;
    if (prev && prev.hasRows) {
      const stored = await loadStoredParse(client, rooms, id, rooms.user, prev.epoch);
      const d = decideEpoch({ ...prev, ...stored }, rows);
      epoch = d.epoch;
      if (d.reason) {
        bumped++;
        console.log(`[memhouse] ${id} → epoch ${epoch} (${d.reason}); the previous parse is kept`);
      }
    } else if (prev) {
      epoch = toInt(prev.epoch);
    }
    rows.session.epoch = epoch;
    await push('sessions', scrub(rows.session));
    sessions++;
    for (const r of rows.msgRows) { r.epoch = epoch; await push('messages', scrub(r)); msgRows++; }
    for (const r of rows.toolRows) { r.epoch = epoch; await push('tool_calls', scrub(r)); toolRows++; }
  }
  for (const table of Object.keys(batches)) await flush(table);
  // Anything that only failed while reading messages — the sink is reset by the
  // next getAllChats(), so unreported here means never reported at all.
  reportAdapterErrors(warned);
  return { sessions, skipped, msgRows, toolRows, unreadable, bumped, withheld };
}

// Warn once per adapter per pass. `warned` carries across the two call sites so one
// unreadable store is not reported twice in the same run.
//
// The loud case used to be a missing better-sqlite3 binding, which took five adapters
// out together and came with a reinstall command attached. SQLite ships with Node now;
// what is left is per-store, and each error already says what happened.
function reportAdapterErrors(warned) {
  const errors = getAdapterErrors().filter((e) => !warned.has(e.source));
  if (!errors.length) return;
  for (const e of errors) warned.add(e.source);
  for (const e of errors) {
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
  let client = makeClient();
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
        console.log(`[memhouse] shipped ${r.sessions} sessions (${r.skipped} skipped`
          + `${r.unreadable ? `, ${r.unreadable} unreadable-will-retry` : ''}`
          + `${r.withheld ? `, ${r.withheld} withheld-empty` : ''}`
          + `${r.bumped ? `, ${r.bumped} kept an earlier parse` : ''}) → ` +
          `${r.msgRows} msg rows, ${r.toolRows} tool rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        failed = true;
        var adoptedCredential = false;
        // A connection failure arrives as an AggregateError whose own `message` is empty,
        // so this printed "[memhouse] pass failed:" and nothing else, after 35 lines of
        // driver internals. Dig out a cause and name the fix; `status` and `doctor`
        // already handle the same condition cleanly and `ship` was the odd one out.
        const causes = (e && e.errors) ? e.errors.map((x) => x && x.message).filter(Boolean) : [];
        const why = e.message || causes[0] || e.code || String(e);
        console.error(`[memhouse] pass failed: ${why}`);
        if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(why + causes.join(' '))) {
          console.error(`[memhouse] ${process.env.MEMHOUSE_URL} did not answer — is the house running?`);
        } else if (/Authentication failed|ACCESS_DENIED|Not enough privileges/i.test(why)) {
          // This process was spawned with one credential; the env FILE may hold a newer one
          // — `install --env` rotates the invite password and rewrites the file, and
          // `memhouse passwd` can run under a live daemon. Retrying the dead copy for
          // 300s a pass while the file beside it is right is what a drill member watched
          // for twelve minutes. Adopt the file, rebuild the client, retry now.
          const envPath = require('path').join(process.env.MEMHOUSE_HOME || require('path').join(require('os').homedir(), '.memhouse'), 'env');
          let drift = { changed: [] };
          try { drift = require('../envfile').credentialDrift(require('fs').readFileSync(envPath, 'utf-8'), process.env); } catch { /* no file: nothing to adopt */ }
          if (drift.changed.length) {
            for (const k of drift.changed) process.env[k] = drift.values[k];
            client = makeClient();
            adoptedCredential = true;
            console.error(`[memhouse] ${envPath} holds a newer ${drift.changed.map((k) => k.replace('MEMHOUSE_', '').toLowerCase()).join('/')} — adopting it and retrying now`);
          } else {
            console.error(`[memhouse] the credential this shipper holds was rejected by ${process.env.MEMHOUSE_URL} (and ${envPath} says the same)`);
          }
        } else if (/does not exist|UNKNOWN_TABLE|UNKNOWN_DATABASE/i.test(why)) {
          console.error('[memhouse] the house is missing a room this pass needed');
        }
        // doctor diagnoses every one of these and prints the fix, so say so ALWAYS rather
        // than only for the one failure mode that happened to be special-cased. The line
        // this used to end on — "MEMHOUSE_DEBUG=1 for the full error" — is a next step for
        // filing a bug, not for fixing the house.
        console.error('[memhouse] diagnose it with: memhouse doctor');
        if (process.env.MEMHOUSE_DEBUG) console.error(e);
        else console.error('[memhouse] (MEMHOUSE_DEBUG=1 for the full error)');
        if (!loop) process.exitCode = 1;
      }
      full = false; // --full applies to the first pass only; loop passes stay incremental
      if (loop) {
        const waitMs = failed ? (adoptedCredential ? 1000 : Math.min(retryMs, intervalSec * 1000)) : intervalSec * 1000;
        if (failed) {
          console.error(`[memhouse] retrying in ${Math.round(waitMs / 1000)}s`);
          retryMs = Math.min(retryMs * 2, intervalSec * 1000);
        } else {
          retryMs = RETRY_START_MS;
        }
        await new Promise((r) => setTimeout(r, waitMs));
        resetCaches(); // adapters cache chat lists; drop them so new sessions surface
        // Then, before the next pass, notice if the installation underneath us changed.
        // Checked AFTER the wait rather than before it so an upgrade landing mid-sleep is
        // acted on at the top of the next pass instead of one whole interval later — and
        // never mid-pass, where handing over would abandon a half-shipped session.
        // Does not return when it hands over.
        selfUpdate.maybeRestart({ snap: selfSnap, name: 'shipper' });
      }
    } while (loop);
  } finally {
    await client.close();
  }
}

module.exports = { runShip, ensureSchema, templateColumns, decideEpoch };

if (require.main === module) {
  main().catch((e) => {
    // A permissions failure here is not a crash — the CALLER (install, doctor) catches the
    // same condition and prints a refusal naming both routes. Printing "[memhouse] fatal:"
    // first put a raw driver sentence above that refusal and made a handled case read like
    // an unhandled one.
    // Exit quietly ONLY where a caller is known to print the refusal itself: install and
    // doctor both catch this condition and name both routes. Everywhere else — and
    // `memhouse ship` is everywhere else — silence plus exit 1 is the worst possible
    // output, and this suppression produced exactly that for a member following the
    // advice to run `ship --ensure-schema`.
    const m = e && e.message ? e.message : String(e);
    if (/Not enough privileges|ACCESS_DENIED/i.test(m) && process.env.MEMHOUSE_QUIET_DENIED === '1') process.exit(1);
    // The sorting-key refusal joins the permissions one: both are the shipper DECLINING
    // to act, with the remediation already in the message. "fatal:" ahead of it made the
    // most-seen line of the upgrade path — every `--ensure-schema` on a pre-epoch house —
    // read like a crash.
    console.error(`[memhouse] ${/Not enough privileges|ACCESS_DENIED|wrong sorting key/i.test(m) ? 'refused' : 'fatal'}: ${m}`);
    process.exit(1);
  });
}
