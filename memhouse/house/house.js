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
    LEFT JOIN ${messages} AS m FINAL ON m.session_id = s.session_id AND m.user_id = s.user_id
    GROUP BY s.session_id, s.user_id
    SETTINGS join_use_nulls = 1
  )`;
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
  for (const t of ROOM_TYPES) out[t] = t;
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
async function resolveRooms(client) {
  return roomNames(await currentUser(client));
}

module.exports = {
  ROOM_TYPES, ROOM_KEYS, keyProblem, READ_SETTINGS, MEMBER_PIN,
  installCommand, assertUsableName,
  sessionsRollup, roomNames, currentUser, resolveRooms,
};
