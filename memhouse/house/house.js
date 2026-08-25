// The house.
//
// A house is a ClickHouse DATABASE, `mem` by default. Its rooms are tables — `sessions`,
// `messages`, `tool_calls` — one set per member, named for them, and two columns say who
// and where every row came from:
//
//   user_id  String MATERIALIZED currentUser()   — stamped by the server, unforgeable by
//                                                  clients (async_insert is pinned to 0
//                                                  on the user so the stamp cannot be
//                                                  skipped)
//   host     LowCardinality(String)              — the machine's fingerprint, minted once
//                                                  per install (../host.js)
//
// That pair IS the provenance model.
//
// ONE LAYOUT. A house is a database — `mem` unless somebody has a reason — and every
// member's rooms in it carry the member's name: `mem.alice_messages`, `mem.polat_messages`.
// A member holds one grant, on the wildcard `mem.<name>_*`, and nothing else in the
// database. That is the whole access model, and roomNames() below is the only place a
// table name is produced.
//
//   alone on a laptop        mem.polat_*            a house of one
//   a team on one server     mem.polat_*, mem.alice_*
//   an agency on a kernel    the same, in the kernel's `mem`
//
// Nobody ever holds ALL ON <db>.*. That grant is dynamic — it covers rooms created later —
// and it is what turned two members in one database into a leak: either could read and
// re-grant the other's transcripts, measured. The wildcard reaches nothing outside the
// member's own name: measured, a member cannot create, read, list or re-grant a
// housemate's rooms, and can read their own grant back with SHOW GRANTS in one line.
//
// THIS FILE HAS SAID THREE OTHER THINGS. Shared tables with row policies (0.4.0: policies
// are permissive and OR'd, a catch-all fails open). Suffixed per-member rooms with Merge
// rooms over them (0.8.0: removed because clients had to resolve names first and
// isolation "solved a problem the product did not have" — the second half was wrong).
// Then a house per member with `ALL ON db.*`, plus a prefixed variant beside it, plus the
// machinery to keep the two from meeting. All three were special cases of this one.
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
// `<member>_meta` / `<member>_events` since the one-layout: every row in them is about ONE
// member (their schema version, their machines, their last ship, their shares), so the old
// `house_` prefix named the wrong unit. A pre-one-layout house still has `house_meta` /
// `house_events`; the shipper's legacy guard names the rename.
const META_TYPES = ['meta', 'events'];

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
 * meta['min_writer_schema']. Today it equals SCHEMA_VERSION; a future
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

function currentParse(table, epochSource = table, physical = null) {
  // `table` names the ROOM (for the materialized-column lookup); `physical` is what goes
  // into the FROM, which differs whenever a prefix is in play.
  const extra = (ROOM_MATERIALIZED[table] || ['user_id']).join(', ');
  const from = physical || table;
  const epochFrom = physical ? physical.replace(new RegExp(`${table}$`), epochSource) : epochSource;
  return `(
    SELECT *, ${extra}
    FROM ${from} FINAL
    WHERE origin != 'ship'
       OR (session_id, user_id, epoch) IN (
            SELECT session_id, user_id, max(epoch)
            FROM ${epochFrom}
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
// The per-(session, model) and per-(session, tool) rollups — what lets the cost, model
// and tool queries stop scanning the messages/tool_calls rooms entirely. Same refresh
// mechanism as SESSION_STATS; same fallback rule: absent tables mean the legacy SQL.
const MODEL_STATS = 'session_model_stats';
const TOOL_STATS = 'session_tool_stats';

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
 * The two fine-grained rollups, same shape as sessionStatsStatements.
 *
 * MODEL_STATS one row per (session, user, source, folder, model), token sums included.
 * Every model/cost aggregate the dashboard runs is a sum or argMax over these rows —
 * a few thousand of them — instead of a scan of the full messages room. The ORPHAN
 * (any-token) predicates in the read layer survive unchanged: a message row with zero
 * tokens contributes zero to every sum, so filtering it out before summing and summing
 * over everything produce the same number.
 *
 * TOOL_STATS one row per (session, user, source, folder, tool_name) with the call
 * count. NOTE the epoch source: currentParse(tool_calls, 'messages') — the tool room
 * takes its epoch from MESSAGES, because a parse that keeps its messages but emits no
 * tool calls writes nothing here at the new epoch, and this room's own max(epoch)
 * would resurrect the superseded parse's calls.
 */
function sessionModelStatsStatements(rooms, { intervalMinutes = 5 } = {}) {
  const body = `SELECT session_id, user_id, any(source) AS source, any(folder) AS folder, model,
       count() AS msgs,
       sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
       sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens
FROM ${rooms.messages} AS m
GROUP BY session_id, user_id, model`;
  return [
    `CREATE TABLE IF NOT EXISTS ${MODEL_STATS} ENGINE = MergeTree `
      + `ORDER BY (session_id, user_id, model) EMPTY AS ${body}`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${MODEL_STATS}_mv `
      + `REFRESH EVERY ${intervalMinutes} MINUTE TO ${MODEL_STATS} AS ${body}`,
  ];
}

function sessionToolStatsStatements(rooms, { intervalMinutes = 5 } = {}) {
  const body = `SELECT session_id, user_id, any(source) AS source, any(folder) AS folder, tool_name,
       count() AS calls
FROM ${rooms.tool_calls} AS tc
GROUP BY session_id, user_id, tool_name`;
  return [
    `CREATE TABLE IF NOT EXISTS ${TOOL_STATS} ENGINE = MergeTree `
      + `ORDER BY (session_id, user_id, tool_name) EMPTY AS ${body}`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${TOOL_STATS}_mv `
      + `REFRESH EVERY ${intervalMinutes} MINUTE TO ${TOOL_STATS} AS ${body}`,
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
/**
 * The table a room type lands in. THE naming rule, and the only copy of it.
 *
 * ONE LAYOUT. Every member's rooms carry the member's own name: `mem.alice_messages`,
 * and `mem.polat_messages` even when polat is the only one in there. A house with one
 * member is a house of one, not a different kind of house — so there is no second case
 * here, no prefix to configure, and nothing for an invite file to carry.
 *
 * Depends on nothing but the member, so a caller holding only a config can name a table
 * without a server round-trip. That matters: when the rule lived only inside roomNames(),
 * callers that could not afford `SELECT currentUser()` spelled tables by hand instead —
 * eight of them, all swallowing the error — and a house silently had no metadata plane.
 */
function physicalRoom(type, user) {
  if (!user) throw new Error(`physicalRoom(${type}): a room belongs to a member, and none was given`);
  return `${user}_${type}`;
}

/** The wildcard every grant to a member is scoped to: `<member>_*`. */
function roomPattern(user) {
  if (!user) throw new Error('roomPattern: a member is required');
  return `${user}_*`;
}

function roomNames(user) {
  if (!user) throw new Error('roomNames: a member is required');
  const out = { member: user, user, pattern: roomPattern(user) };
  // Every room name in the codebase comes from physicalRoom() above — through this
  // function where a caller has the rooms, directly where it has only a member name.
  const phys = (t) => physicalRoom(t, user);
  out.physical = {};
  for (const t of [...ROOM_TYPES, ...META_TYPES]) out.physical[t] = phys(t);
  // The raw table names — for INSERT, for DDL, and for the shipper's own bookkeeping
  // reads, which have to see every epoch to decide which one to write next.
  for (const t of ROOM_TYPES) out[`${t}_raw`] = phys(t);
  // What everything else gets. `sessions` is unfiltered: it is one metadata row per
  // session by construction, latest-wins, and carries no epoch anyone may read.
  out.sessions = phys('sessions');
  out.messages = currentParse('messages', 'messages', phys('messages'));
  // tool_calls takes its epoch from MESSAGES, not from itself. A parse that produces
  // messages but NO tool calls is ordinary — a compaction can remove every assistant turn
  // that called something — and it writes zero rows into this room at the new epoch. Asked
  // for its own max(epoch), the room would answer with the SUPERSEDED epoch and serve the
  // old parse's tool calls beside the new parse's messages. Both rooms are written by the
  // same pass at the same epoch, so messages is the authority for both.
  out.tool_calls = currentParse('tool_calls', 'messages', phys('tool_calls'));
  // The house's own record of itself — plain names, nothing to filter.
  for (const t of META_TYPES) { out[t] = phys(t); out[`${t}_raw`] = phys(t); }
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
async function statTables(client) {
  try {
    const rs = await client.query({
      query: `SELECT name FROM system.tables
              WHERE database = currentDatabase()
                AND name IN ('${SESSION_STATS}', '${MODEL_STATS}', '${TOOL_STATS}')`,
      format: 'JSONEachRow',
    });
    return new Set((await rs.json()).map((r) => r.name));
  } catch {
    // No grant on system.tables is not an error — it means "assume none", and the
    // subquery path is always correct.
    return new Set();
  }
}

async function hasSessionStats(client) {
  return (await statTables(client)).has(SESSION_STATS);
}

async function resolveRooms(client) {
  const rooms = roomNames(await currentUser(client));
  const have = await statTables(client);
  if (have.has(SESSION_STATS)) rooms.sessions_v = SESSION_STATS;
  // Null when absent: the read layer branches to the legacy scan-the-room SQL. Never a
  // token substitution, because the legacy SQL has a different shape, not just a
  // different table name.
  rooms.model_stats = have.has(MODEL_STATS) ? MODEL_STATS : null;
  rooms.tool_stats = have.has(TOOL_STATS) ? TOOL_STATS : null;
  return rooms;
}

/**
 * The text-index DDL for servers before the tokenizer grammar changed. 25.8 spells a
 * tokenizer as a quoted name with options — `text(tokenizer = 'ngram', ngram_size = 3)`,
 * `text(tokenizer = 'default')` — and rejects the function form with "Expected literal";
 * 26.x spells it as a function — `ngrams(3)`, `splitByNonAlpha` — and rejects the quoted
 * names as "Unknown tokenizer". Neither parses the other. The template carries the
 * current grammar; this rewrites a statement to the older one when a server refuses it.
 * `default` in the old grammar is the non-alphanumeric splitter, which is what
 * `splitByNonAlpha` names in the new one, so the indexes built are the same.
 */
function legacyTextIndexDialect(sql) {
  return sql
    .replace(/TYPE text\(tokenizer = ngrams\((\d+)\)\)/g, "TYPE text(tokenizer = 'ngram', ngram_size = $1)")
    .replace(/TYPE text\(tokenizer = splitByNonAlpha\)/g, "TYPE text(tokenizer = 'default')");
}

/**
 * Which text-index grammar a server speaks, from `SELECT version()`. Measured on real
 * builds: 25.8 and 25.9 want the quoted-name form, 25.10 onwards the function form, and
 * each rejects the other. Anything unparseable is treated as current; the shipper still
 * falls back on a grammar refusal, so a wrong guess costs one round-trip, not the install.
 */
function textIndexDialectFor(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || '').trim());
  if (!m) return 'modern';
  const major = Number(m[1]); const minor = Number(m[2]);
  return (major < 25 || (major === 25 && minor < 10)) ? 'legacy' : 'modern';
}

/** True when a server's refusal is the grammar, not a privilege or a real mistake. */
function isTextIndexGrammarRefusal(message) {
  return /Expected literal|supports only 'default'|Unknown tokenizer/.test(String(message || ''));
}

module.exports = {
  physicalRoom, roomPattern, legacyTextIndexDialect, isTextIndexGrammarRefusal, textIndexDialectFor,
  ROOM_TYPES, META_TYPES, SCHEMA_VERSION, SUPPORTED_SCHEMAS, MIN_WRITER_SCHEMA,
  MIGRATIONS, ROOM_KEYS, keyProblem,
  READ_SETTINGS, MEMBER_PIN,
  installCommand, assertUsableName,
  sessionsRollup, currentParse, createStatement, roomNames, currentUser, resolveRooms,
  SESSION_STATS, MODEL_STATS, TOOL_STATS, hasSessionStats, statTables,
  sessionStatsStatements, sessionModelStatsStatements, sessionToolStatsStatements,
};
