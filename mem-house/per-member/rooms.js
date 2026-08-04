// Room-name resolution for the per-member layout.
//
// The shared layout has three rooms named `sessions`, `messages`, `tool_calls`. The
// per-member layout gives every member their own, named TYPE-FIRST:
// `sessions_<member>`, `messages_<member>`, `tool_calls_<member>`.
//
// Which layout is in play is decided by MEM_PER_MEMBER, so one shipper serves both while
// this fork is unproven. The member is never supplied by the caller — it is read back from
// the server with currentUser(), the same value the rooms' user_id column is stamped with.
// A client that could name its own member could write into someone else's rooms.
//
// `sessions_v` IS A SAVED QUERY HERE, NOT A ROOM. `SCHEMA-v4` decided that and it was
// briefly implemented as a stored view instead; the view cost a name inside the
// `^sessions_` namespace the Merge rooms select on (it was silently merged into
// `all_sessions`, doubling every count), a fourth grant per member, and a fourth object
// to provision, roll forward and drop. A saved query is substituted with the caller's own
// room names and runs under the caller's credential, so it inherits their grants and
// raises no view-ownership question at all.

const ROOM_TYPES = ['sessions', 'messages', 'tool_calls'];

function perMemberEnabled() {
  return process.env.MEM_PER_MEMBER === '1';
}

// ClickHouse usernames are permissive; room names are not. Refuse anything that would
// need quoting or could change how a Merge regex or a name-splitter reads.
function assertUsableMember(member) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(member)) {
    throw new Error(`cannot build room names for user '${member}': expected [A-Za-z][A-Za-z0-9_]*`);
  }
  // A handle whose room name IS a shared-layout object name. Only `v` does this today
  // (`sessions_v` is the shared rollup view), and only that one name matters — but the
  // check is written against SHARED_OBJECTS so it stays true if either set is renamed.
  // Case-sensitive on purpose: ClickHouse identifiers are, so `sessions_V` is a different
  // object and rejecting it would be over-reach.
  for (const t of ROOM_TYPES) {
    if (SHARED_OBJECTS.has(`${t}_${member}`)) {
      throw new Error(`'${member}' is reserved: ${t}_${member} is the shared layout's own object name`);
    }
  }
}

/**
 * The session rollup, as SQL text rather than a name.
 *
 * Two properties of the shared `sessions_v` view must survive the port, and both are load
 * bearing: the join is a LEFT JOIN, so a session with no messages still appears with zero
 * aggregates instead of vanishing from every count; and `join_use_nulls = 1` makes the
 * unmatched message columns NULL so `coalesce` yields true zeros rather than counting the
 * placeholder row. The setting is applied by the CALLER (a client setting, not a trailing
 * SETTINGS clause) because this text is used as a subquery, and a subquery cannot carry
 * its own SETTINGS.
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
    FROM ${sessions} AS s
    LEFT JOIN ${messages} AS m ON m.session_id = s.session_id AND m.user_id = s.user_id
    GROUP BY s.session_id, s.user_id
  )`;
}

/**
 * The settings every read needs, whichever layout is in play. `final` collapses
 * ReplacingMergeTree versions; `join_use_nulls` is what the rollup's coalesce depends on
 * and used to ride along inside the view's own SETTINGS clause.
 */
const READ_SETTINGS = { final: 1, join_use_nulls: 1 };

/**
 * Every object the SHARED layout owns in a house — `../schema.sql`, plus the rollup view.
 *
 * `sessions_v` is the dangerous one. It sits inside the `^sessions_` namespace the Merge
 * rooms select on, so a house holding both layouts merges the shared rollup VIEW into the
 * member session rooms. Measured on 26.7.1: two member rooms holding one row each made
 * `all_sessions` return three, and the extra row is not a session. The base tables do not
 * collide (`sessions` has no trailing underscore) but their presence still means the
 * house is running the other layout, and one shipper cannot serve both.
 */
const SHARED_OBJECTS = new Set(['sessions', 'messages', 'tool_calls', 'sessions_v']);

/**
 * Names, given the member the server reported. Shared by every caller so the two
 * transports in the tree (@clickhouse/client and the CLI's raw fetch) cannot drift into
 * two different naming rules.
 *
 * `member` null means the shared layout. `sessions_v` is the shared layout's stored view
 * by name, and the per-member layout's rollup as SQL text — both usable in the same
 * `FROM ... AS c` position, which is the whole point.
 */
function roomNames(member, user = member) {
  const out = { member, user, perMember: member !== null };
  if (member === null) {
    for (const t of ROOM_TYPES) out[t] = t;
    out.sessions_v = 'sessions_v';
    return out;
  }
  assertUsableMember(member);
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
 * Returns { sessions, messages, tool_calls, sessions_v, member, user, perMember }.
 *
 * `user` is the identity the server reports, and is resolved in BOTH layouts — writers
 * need the value itself, not just the name it produces. See ship.js's delete.
 */
async function resolveRooms(client) {
  const user = await currentUser(client);
  if (!perMemberEnabled()) return roomNames(null, user);
  return roomNames(user, user);
}

/** The three Merge rooms — team-wide read paths, owner-managed. */
function mergeRooms() {
  return { sessions: 'all_sessions', messages: 'all_messages', tool_calls: 'all_tool_calls' };
}

module.exports = {
  ROOM_TYPES, READ_SETTINGS, SHARED_OBJECTS, perMemberEnabled, assertUsableMember,
  sessionsRollup, roomNames, currentUser, resolveRooms, mergeRooms,
};
