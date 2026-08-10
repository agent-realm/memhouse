// Room-name resolution.
//
// Every member owns their rooms, named TYPE-FIRST: `sessions_<member>`,
// `messages_<member>`, `tool_calls_<member>`. Type-first is what lets the Merge rooms
// anchor on a fixed room type (`^sessions_`) and never match themselves.
//
// THIS IS THE ONLY LAYOUT. There was a shared one — three rooms named `sessions`,
// `messages`, `tool_calls`, with row policies narrowing each caller to their own rows —
// and it is gone. A shared read is a Merge room plus a GRANT, which is strictly less
// machinery than a policy that has to be right on every table and every read path; and
// isolation by absent grant fails closed, where a row policy fails open the moment one is
// missing.
//
// The member is never supplied by the caller — it is read back from the server with
// currentUser(), the same value the rooms' user_id column is stamped with. A client that
// could name its own member could write into someone else's rooms.
//
// `sessions_v` IS A SAVED QUERY, NOT A ROOM. It was briefly a stored view, which cost a
// name inside the `^sessions_` namespace the Merge rooms select on (silently merged into
// `all_sessions`, doubling every count), a fourth grant per member, and a fourth object to
// provision, roll forward and drop. A saved query is substituted with the caller's own
// room names and runs under the caller's credential, so it inherits their grants and
// raises no view-ownership question at all.

const ROOM_TYPES = ['sessions', 'messages', 'tool_calls'];

// ClickHouse usernames are permissive; room names are not. Refuse anything that would
// need quoting or could change how a Merge regex or a name-splitter reads.
function assertUsableMember(member) {
  if (typeof member !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(member)) {
    throw new Error(`cannot build room names for user '${member}': expected [A-Za-z][A-Za-z0-9_]*`);
  }
}

/**
 * The session rollup, as SQL text rather than a name.
 *
 * Two properties are load bearing: the join is a LEFT JOIN, so a session with no messages
 * still appears with zero aggregates instead of vanishing from every count; and
 * `join_use_nulls = 1` makes the unmatched message columns NULL so `coalesce` yields true
 * zeros rather than counting the placeholder row.
 *
 * BOTH ARE NOW CARRIED BY THE TEXT ITSELF — `FINAL` on each room and a trailing
 * `SETTINGS join_use_nulls = 1`. It used to depend on the caller passing `final=1` and
 * `join_use_nulls=1`, on the belief that a subquery cannot carry its own SETTINGS. It can
 * (verified on 26.7 and 25.11), and the belief was expensive: every consumer that forgot
 * the settings silently counted each message once per undeleted ReplacingMergeTree
 * version. Measured right after a `ship --full` — 2x, and 3x three ships later. It does
 * not self-heal; the error grows with each pass until a merge happens to collapse the
 * parts. `memhouse sessions-query > q.sql` lost the warning entirely, because it was
 * printed on stderr as a SQL comment that never reached the SQL.
 *
 * Passing final=1 as well is harmless, so READ_SETTINGS stays as it is for direct room
 * reads, which still need it.
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
 * Names, given the member the server reported. Shared by every caller so the two
 * transports in the tree (@clickhouse/client and the CLI's raw fetch) cannot drift into
 * two different naming rules.
 *
 * `sessions_v` is the rollup as SQL text, usable in the same `FROM ... AS c` position a
 * view name would occupy — which is what lets the read layer treat it as just another
 * resolved name.
 */
function roomNames(member, user = member) {
  assertUsableMember(member);
  const out = { member, user };
  for (const t of ROOM_TYPES) out[t] = `${t}_${member}`;
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

/**
 * Resolve the rooms for whoever this client is connected as.
 * Returns { sessions, messages, tool_calls, sessions_v, member, user }.
 *
 * `user` is the identity the server reports. Writers need the value itself, not just the
 * name it produces — see ship.js's delete, which must BIND the user rather than call
 * currentUser() inside a mutation, where it is not evaluated in the caller's context.
 */
async function resolveRooms(client) {
  const user = await currentUser(client);
  return roomNames(user, user);
}

/** The three Merge rooms — team-wide read paths, owner-managed. */
function mergeRooms() {
  return { sessions: 'all_sessions', messages: 'all_messages', tool_calls: 'all_tool_calls' };
}

module.exports = {
  ROOM_TYPES, READ_SETTINGS, assertUsableMember,
  sessionsRollup, roomNames, currentUser, resolveRooms, mergeRooms,
};
