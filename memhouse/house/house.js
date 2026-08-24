// The house.
//
// A house is a ClickHouse DATABASE — any database, named whatever its people name it
// (`polat`, `team_a`, even `default`). Its rooms are three plain tables: `sessions`,
// `messages`, `tool_calls`. Everyone in the house writes into the SAME tables, each with
// their own credential, and two columns say who and where every row came from:
//
//   user_id  String MATERIALIZED currentUser()   — stamped by the server, unforgeable by
//                                                  clients (async_insert is pinned to 0
//                                                  on the user so the stamp cannot be
//                                                  skipped)
//   host     LowCardinality(String)              — the machine's fingerprint, minted once
//                                                  per install (../host.js)
//
// That pair IS the provenance model. Alice and Bob point their shippers at `team_a` and
// both write; `WHERE user_id = 'alice'` is one person, `WHERE host = '…'` is one machine.
// The model is collaborative — housemates trust each other with the house — and the
// boundary between houses is the database: joining someone's ClickHouse takes a database
// and a credential (`GRANT ALL ON team_a.* TO alice`), nothing else, because ALL on your
// own database reaches nothing outside it.
//
// THIS REPLACES THE PER-MEMBER LAYOUT. Rooms were `sessions_<member>` with per-member
// grants, Merge rooms for team reads, and isolation between members of one database.
// All of it is gone: suffixed names made every client resolve its room names first (and
// `FROM messages` a documented trap), the Merge rooms existed only to undo the
// splitting, and per-member isolation inside a shared house solved an adversarial
// problem the product does not have. Separate houses isolate; one house shares.
//
// `sessions_v` IS A SAVED QUERY, NOT AN OBJECT — substituted into the same `FROM … AS c`
// position a view name would occupy, running under the caller's own credential. It was
// briefly a stored view; that cost an object to provision and grant, and a name for the
// old Merge selectors to swallow.

const ROOM_TYPES = ['sessions', 'messages', 'tool_calls'];

/**
 * The house's own record of itself — not rooms. Nothing about a conversation lives in
 * them, the shipper's guards do not require them, and a member who cannot create them
 * still ships normally.
 */
const META_TYPES = ['house_meta', 'house_events'];

/**
 * What generation of the schema a house is at. Bumped only when existing rooms have to be
 * REBUILT to keep working — a new column is not a version, because ensureSchema rolls one
 * out in place.
 *
 *   1  0.4.x–0.9.x  shared rooms, origin in the transcript keys
 *   2  0.10.0       epoch in the transcript keys; the shipper became insert-only
 *
 * A house at 1 is not broken, it is un-migrated: its rooms cannot hold two parses of a
 * session, so the shipper refuses to write rather than overwrite. `memhouse migrate-rooms`
 * moves it to 2.
 */
const SCHEMA_VERSION = 2;
const MIGRATIONS = {
  2: '0100-epoch-key',
};

/**
 * Which schema generations THIS release may write. The degenerate compatibility matrix:
 * a release supports exactly its own generation, and the array exists for the rare
 * release that is wire-compatible across two (write both, migrate at leisure).
 *
 * The check that reads this (ship.js assertWriterSupported) is the forward half of the
 * mixed-fleet story: every release from 0.10.0 on REFUSES a house whose recorded schema
 * it does not support, in both directions — a house too new says "update memhouse", a
 * house too old says "memhouse migrate". The backward half cannot be code: releases
 * already on the registry read none of this, so for them the enforcement is the pilot's
 * GRANTs (revoke the mutation privileges after migrating, and a pre-0.10 shipper's
 * delete fails loudly instead of destroying retained parses). `memhouse migrate` prints
 * that advice.
 */
const SUPPORTED_SCHEMAS = [2];

/**
 * The floor a house may set under its writers, recorded by `memhouse migrate` in
 * house_meta['min_writer_schema']. Today it equals SCHEMA_VERSION; a future
 * back-compatible generation can hold it one step lower for a grace window.
 */
const MIN_WRITER_SCHEMA = 2;

/**
 * The sorting key each room MUST have, as the column list ClickHouse reports in
 * `system.tables.sorting_key`. Canonical here because three places check it — the shipper
 * before every pass, `doctor`, and the room rebuild — and they disagreed once already: the
 * shipper's guard lived only in `--ensure-schema`, so 137 sessions shipped straight past
 * it into a stale-key house.
 *
 * Two of the five columns are the whole data-safety story, and both were bought with
 * measured losses:
 *
 *   origin — an imported row and a shipped row at the same seq must be TWO rows.
 *            Without it RMT collapses them and the import loses; 27,948 messages went
 *            that way on a real house.
 *   epoch  — a superseded parse and its replacement must be TWO rows, so a re-parse that
 *            shrinks or diverges can be written WITHOUT deleting what it replaces. This is
 *            what removed the shipper's DELETE.
 *
 * `sessions` is deliberately keyed on neither: it holds exactly one metadata row per
 * session, and a second one makes sessions_v join messages twice and over-report (measured
 * on a real house — one duplicate row inflated the totals by 1,764 messages and 655M
 * tokens).
 */
const ROOM_KEYS = {
  sessions: ['session_id', 'user_id'],
  messages: ['session_id', 'user_id', 'origin', 'epoch', 'seq'],
  tool_calls: ['session_id', 'user_id', 'origin', 'epoch', 'idx'],
};

/**
 * What is wrong with a room's sorting key, or null when nothing is. `sortingKey` is the
 * raw `system.tables.sorting_key` value; pass '' for a table that reports none.
 *
 * An EXISTING room reporting no sorting key at all is not a MergeTree — a Merge, a View, a
 * Log engine standing where a room belongs. Skipping that case let a ship pass sail past
 * its own guard and die later on `DELETE query is not supported for table …`, and let
 * doctor print "✓ sorting keys carry origin correctly (2/3 rooms)" over a broken house.
 */
function keyProblem(type, sortingKey) {
  const want = ROOM_KEYS[type];
  if (!want) return `'${type}' is not a room type`;
  const key = String(sortingKey || '').trim();
  if (!key) return 'not a MergeTree, so it cannot be shipped to';
  const have = key.split(',').map((s) => s.trim()).filter(Boolean);
  if (have.length === want.length && have.every((c, i) => c === want[i])) return null;
  return `(${key}) — expected (${want.join(', ')})`;
}

// The one server-side setting a member carries, applied directly on the user with
// ADD SETTING (bare `ALTER USER … SETTINGS` REPLACES the user's whole list — measured, it
// wiped an operator-set ceiling; ADD SETTING merges and upserts). There is no settings
// profile: the shared object detached members on replace and its server-global name made
// two houses on one server rewrite each other's.
//
// The pin is correctness, not policy. `user_id MATERIALIZED currentUser()` is computed
// during the INSERT, and an ASYNC insert flushes outside that context — measured on
// 25.11.9.34, `async_insert=1` stores user_id as the EMPTY STRING while a sync insert
// stamps correctly. The shipper always passes async_insert=0; the pin guards every OTHER
// holder of the credential. CONST refuses the override; a client that never mentions the
// setting is held at 0 and its insert lands stamped.
const MEMBER_PIN = 'async_insert = 0 CONST';

/**
 * The global-install command that will actually work HERE.
 *
 * The flag half of this is gone: the command carried `--allow-scripts=better-sqlite3`
 * for as long as SQLite was a native module, and omitting it silently cost five
 * adapters. `node:sqlite` needs no install script, so the base command is now the plain
 * one everybody already types.
 *
 * The `sudo` half stays, because it was never about the flag. A bare install fails with
 * EACCES on any distro-packaged Node, because the global prefix is root-owned — measured
 * on a clean Ubuntu machine, exit 243. `sudo` is right for exactly one of the two causes
 * and makes the other worse, and what tells them apart is who owns the prefix — so look,
 * rather than guess.
 */
function installCommand() {
  const base = 'npm install -g memhouse';
  try {
    const { execFileSync } = require('child_process');
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const st = require('fs').statSync(prefix);
    if (st.uid !== process.getuid()) return `sudo ${base}`;
  } catch { /* npm not on PATH, or an unreadable prefix: fall through to the plain form */ }
  return base;
}

// Identifier check for anything we splice into DDL unquoted — house (database) names and
// user names. Refuse what would need quoting rather than quote it: a name a person cannot
// type bare into their own SQL is a name they will get wrong. `default` is deliberately
// ALLOWED as a house name — a stock container's default database is a real place to keep
// a house, and the pilot may pick user 'alice' with house 'default'. Only the names that
// are not a database at all are refused.
const RESERVED_DBS = new Set(['system', 'information_schema']);
function assertUsableName(name, what = 'name') {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`'${name}' cannot be a ${what} — expected [A-Za-z][A-Za-z0-9_]*`);
  }
  if (RESERVED_DBS.has(name.toLowerCase())) {
    throw new Error(`'${name}' cannot be a ${what} — it is ClickHouse's own`);
  }
}

/**
 * One table's CREATE statement, lifted verbatim out of the schema template and renamed.
 *
 * Used by the room rebuild, which cannot construct the DDL from a column list: the
 * sorting key IS the thing being changed, and the text indexes on `messages` carry a
 * syntax (`TYPE text(tokenizer = ngrams(3))`) that no column-level reconstruction would
 * reproduce. Taking the statement whole means a migrated room is byte-for-byte the room a
 * fresh install would create.
 */
function createStatement(tpl, table, asName) {
  // `(?:--[^\n]*\n\s*)*` between the column list and ENGINE: the template comments the
  // engine choice on some tables, and a pattern demanding `) ENGINE` silently matched
  // nothing for those — which reads as "the template has no such table".
  const m = tpl.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table}\\s*\\([\\s\\S]*?\\n\\)\\s*(?:--[^\\n]*\\n\\s*)*ENGINE[\\s\\S]*?;`, 'm'));
  if (!m) throw new Error(`the schema template declares no table '${table}'`);
  return m[0].replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${asName || table}`);
}

/**
 * A transcript room restricted to the CURRENT parse of each session — SQL text, usable
 * wherever the table name would go.
 *
 * The shipper keeps superseded parses (see the epoch column in schema.sql.tpl), so the
 * physical room can hold a session twice: five messages at epoch 0, three at epoch 1.
 * Reading that raw does not merely show stale rows, it makes every aggregate wrong —
 * `total_msgs`, token sums, cost, model counts — which is a worse failure than the stale
 * tail the epoch replaced. The filter is therefore not optional, and it is not left to
 * each query to remember: `roomNames()` hands out THIS for `messages` / `tool_calls`, and
 * the bare table only under `messages_raw` / `tool_calls_raw`. A read path nobody thought
 * to update is correct; a write path nobody updated fails loudly on an insert into a
 * subquery.
 *
 * `origin != 'ship'` first, and it carries the weight: epochs belong to the shipper, and
 * an imported row sits at epoch 0 forever. Filtering it against the shipper's current
 * epoch would hide the entire import behind any session that had been compacted once —
 * the same class of loss as the delete this design removed, arriving as a read that
 * silently returns less.
 *
 * The projection is deliberate: `*` omits MATERIALIZED columns, and the ones this schema
 * has are all load-bearing. `user_id` is what every consumer scopes by (the rollup JOINs
 * on it) and `text_ngram` / `text_word` are what `memhouse search` matches against — a
 * bare `SELECT *` drops all three, and the search fails with `Unknown identifier`.
 * Listing them costs nothing where they are unused: ClickHouse prunes unread columns out
 * of a subquery.
 */
const ROOM_MATERIALIZED = {
  messages: ['user_id', 'text_ngram', 'text_word'],
  tool_calls: ['user_id'],
};

function currentParse(table, epochSource = table) {
  const extra = (ROOM_MATERIALIZED[table] || ['user_id']).join(', ');
  return `(
    SELECT *, ${extra}
    FROM ${table} FINAL
    WHERE origin != 'ship'
       OR (session_id, user_id, epoch) IN (
            SELECT session_id, user_id, max(epoch)
            FROM ${epochSource}
            WHERE origin = 'ship'
            GROUP BY session_id, user_id)
  )`;
}

/**
 * The session rollup as SQL text, usable in the same `FROM ... AS c` position a view name
 * would occupy. Groups by (session_id, user_id): two housemates' rows never merge, even
 * on a colliding session_id.
 */
function sessionsRollup({ sessions, messages }) {
  return `(
    SELECT
        s.session_id AS session_id,
        any(s.source) AS source,
        any(s.host) AS host,
        any(s.name) AS name,
        any(s.mode) AS mode,
        any(s.folder) AS folder,
        any(s.project) AS project,
        any(s.git_branch) AS git_branch,
        s.user_id AS user_id,
        any(s.created_at) AS created_at,
        any(s.last_updated_at) AS last_updated_at,
        min(m.ts) AS started,
        max(m.ts) AS ended,
        coalesce(dateDiff('second', min(m.ts), max(m.ts)), 0) AS duration_sec,
        count(m.seq) AS total_msgs,
        countIf(m.role = 'user') AS user_msgs,
        countIf(m.role = 'assistant') AS assistant_msgs,
        countIf(m.is_subagent) AS subagent_msgs,
        groupUniqArrayIf(m.model, m.model NOT IN ('', '<synthetic>')) AS models,
        coalesce(sum(m.input_tokens), 0) AS input_tokens,
        coalesce(sum(m.output_tokens), 0) AS output_tokens,
        coalesce(sum(m.cache_read_tokens), 0) AS cache_read_tokens,
        coalesce(sum(m.cache_write_tokens), 0) AS cache_write_tokens,
        coalesce(sumIf(length(m.text), m.role = 'user'), 0) AS user_chars,
        coalesce(sumIf(length(m.text), m.role = 'assistant'), 0) AS assistant_chars,
        coalesce(substring(argMinIf(m.text, m.seq, m.role = 'user' AND m.text != ''), 1, 200), '') AS first_prompt
    FROM ${sessions} AS s FINAL
    LEFT JOIN ${messages} AS m ON m.session_id = s.session_id AND m.user_id = s.user_id
    GROUP BY s.session_id, s.user_id
    SETTINGS join_use_nulls = 1
  )`;
}

// The precomputed rollup's table name. One place, because the migration, the runtime
// probe and the read layer must all agree on it.
const SESSION_STATS = 'session_stats';

/**
 * The DDL that materializes the rollup, as [target, view].
 *
 * A REFRESHABLE materialized view, not an ordinary one, and the distinction is not a
 * preference — an ordinary MV is an insert trigger, and all three of this schema's
 * defining properties break it:
 *
 *   DUPLICATES. The rooms are ReplacingMergeTree; the engine collapses re-inserted rows
 *   at MERGE time, long after a trigger has already added them to a sum(). On a real
 *   house that is 1,226,770 stored rows for 685,649 real ones — token totals ~1.8x high,
 *   with nothing to indicate it.
 *
 *   EPOCHS. A trigger firing at insert cannot know a later parse will supersede the rows
 *   it is aggregating, so superseded parses would stay in the totals forever.
 *
 *   THE JOIN. A trigger fires on one source table; the rollup joins sessions to messages.
 *
 * A refreshable view has none of those problems because it is not a trigger: it runs
 * THIS ALREADY-CORRECT QUERY on a schedule and atomically swaps the target. FINAL, the
 * epoch filter and the join all work exactly as they do in the subquery, because it IS
 * the subquery. The price is staleness bounded by the interval — and the shipper's own
 * default cadence is 300s, so a 5-minute refresh adds no lag to data arriving every 5.
 *
 * The target's columns are inferred with EMPTY AS, so the table and the rollup cannot
 * drift: change sessionsRollup and the next migration rebuilds the table to match.
 */
function sessionStatsStatements(rooms, { intervalMinutes = 5 } = {}) {
  const rollup = sessionsRollup(rooms);
  // sessionsRollup wraps itself in parentheses for the FROM position; strip them.
  const body = rollup.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
  return [
    `CREATE TABLE IF NOT EXISTS ${SESSION_STATS} ENGINE = MergeTree `
      + `ORDER BY (session_id, user_id) EMPTY AS ${body}`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${SESSION_STATS}_mv `
      + `REFRESH EVERY ${intervalMinutes} MINUTE TO ${SESSION_STATS} AS ${body}`,
  ];
}

/**
 * The settings every read needs. `final` collapses ReplacingMergeTree versions;
 * `join_use_nulls` is what the rollup's coalesce depends on.
 */
const READ_SETTINGS = { final: 1, join_use_nulls: 1 };

/**
 * Room names. They are constants now — `sessions`, `messages`, `tool_calls`, resolved by
 * the connection's database rather than by who is asking — but the shape survives from
 * the per-member layout so every consumer keeps addressing rooms the same way, and
 * `user` still carries the server-reported identity: writers need the VALUE, not the
 * name it produces. See ship.js's delete, which must BIND the user rather than call
 * currentUser() inside a mutation, where it is not evaluated in the caller's context.
 */
function roomNames(user) {
  const out = { member: user, user };
  // The raw table names — for INSERT, for DDL, and for the shipper's own bookkeeping
  // reads, which have to see every epoch to decide which one to write next.
  for (const t of ROOM_TYPES) out[`${t}_raw`] = t;
  // What everything else gets. `sessions` is unfiltered: it is one metadata row per
  // session by construction, latest-wins, and carries no epoch anyone may read.
  out.sessions = 'sessions';
  out.messages = currentParse('messages');
  // tool_calls takes its epoch from MESSAGES, not from itself. A parse that produces
  // messages but NO tool calls is ordinary — a compaction can remove every assistant turn
  // that called something — and it writes zero rows into this room at the new epoch. Asked
  // for its own max(epoch), the room would answer with the SUPERSEDED epoch and serve the
  // old parse's tool calls beside the new parse's messages. Both rooms are written by the
  // same pass at the same epoch, so messages is the authority for both.
  out.tool_calls = currentParse('tool_calls', 'messages');
  // The house's own record of itself — plain names, nothing to filter.
  for (const t of META_TYPES) { out[t] = t; out[`${t}_raw`] = t; }
  out.sessions_v = sessionsRollup(out);
  return out;
}

async function currentUser(client) {
  const rs = await client.query({ query: 'SELECT currentUser() AS u', format: 'JSONEachRow' });
  const rows = await rs.json();
  const u = rows[0] && rows[0].u;
  if (!u) throw new Error('could not determine currentUser()');
  return u;
}

/** Resolve the rooms for whoever this client is connected as. */
/**
 * The precomputed rollup, when the house has one.
 *
 * `sessions_v` is a SAVED QUERY that rebuilds the whole rollup — sessions FINAL joined
 * to the current parse of messages, grouped over the entire house — on every call. A
 * house that has run the session_stats migration carries the same rows as a flat table,
 * refreshed on a timer, and the read layer can name that instead. Measured on a 714k
 * message house: 1,413,624 rows read per query becomes 1,230, and p50 query time 68ms
 * becomes 4ms.
 *
 * Resolved at RUNTIME rather than by version, and that is the point: one binary has to
 * serve a migrated house, a house whose migration has not run, and a friend's house
 * shared read-only that was never migrated at all. Asking the server what exists is the
 * only answer that is correct in all three.
 */
async function hasSessionStats(client) {
  try {
    const rs = await client.query({
      query: `SELECT count() AS n FROM system.tables
              WHERE database = currentDatabase() AND name = 'session_stats'`,
      format: 'JSONEachRow',
    });
    const rows = await rs.json();
    return Number(rows[0] && rows[0].n) > 0;
  } catch {
    // No grant on system.tables is not an error — it means "assume not", and the
    // subquery path is always correct.
    return false;
  }
}

async function resolveRooms(client) {
  const rooms = roomNames(await currentUser(client));
  if (await hasSessionStats(client)) rooms.sessions_v = SESSION_STATS;
  return rooms;
}

module.exports = {
  ROOM_TYPES, META_TYPES, SCHEMA_VERSION, SUPPORTED_SCHEMAS, MIN_WRITER_SCHEMA,
  MIGRATIONS, ROOM_KEYS, keyProblem,
  READ_SETTINGS, MEMBER_PIN,
  installCommand, assertUsableName,
  sessionsRollup, currentParse, createStatement, roomNames, currentUser, resolveRooms,
  SESSION_STATS, hasSessionStats, sessionStatsStatements,
};
