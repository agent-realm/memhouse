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

const ROOM_TYPES = ['sessions', 'messages', 'tool_calls'];
// Not a room and not granted like one: a view over the member's own rooms. The read layer
// (dashboard, CLI stats/search, `ship --stats`) reads sessions_v rather than the base
// rooms, so it has to resolve alongside them or a per-member house ships fine and then
// reads back nothing.
const VIEW_TYPES = ['sessions_v'];
// ...and it must NOT live in a room type's namespace. The Merge rooms select on
// `^sessions_`, which would swallow a view named `sessions_v_alice` and try to merge an
// aggregate view into the base session rooms. The view is therefore prefixed instead of
// suffixed: `v_sessions_alice`. `v_` cannot collide with a room type, and members cannot
// be named into one because assertUsableMember bans a leading `v_`.
const VIEW_PREFIX = 'v_';

function perMemberEnabled() {
  return process.env.MEM_PER_MEMBER === '1';
}

// ClickHouse usernames are permissive; room names are not. Refuse anything that would
// need quoting or could change how a Merge regex or a name-splitter reads.
function assertUsableMember(member) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(member)) {
    throw new Error(`cannot build room names for user '${member}': expected [A-Za-z][A-Za-z0-9_]*`);
  }
  // A member called `v_bob` would own `v_sessions_v_bob` — harmless — but also make
  // `v_sessions_bob` ambiguous between bob's view and a room of theirs. Reserve the
  // prefix rather than reason about the overlap.
  if (member.startsWith(VIEW_PREFIX)) {
    throw new Error(`member name '${member}' is reserved: '${VIEW_PREFIX}' prefixes the per-member views`);
  }
}

/**
 * Names alone, given the member the server reported. Shared by every caller so the two
 * transports in the tree (@clickhouse/client and the CLI's raw fetch) cannot drift into
 * two different naming rules.
 *
 * `member` null means the shared layout.
 */
function roomNames(member, user = member) {
  const out = { member, user, perMember: member !== null };
  if (member === null) {
    for (const t of [...ROOM_TYPES, ...VIEW_TYPES]) out[t] = t;
    return out;
  }
  assertUsableMember(member);
  for (const t of ROOM_TYPES) out[t] = `${t}_${member}`;
  for (const t of VIEW_TYPES) out[t] = viewName(t, member);
  return out;
}

/** `sessions_v` + alice -> `v_sessions_alice`. Out of every room type's namespace. */
function viewName(type, member) {
  return `${VIEW_PREFIX}${type.replace(/_v$/, '')}_${member}`;
}

async function currentUser(client) {
  const rs = await client.query({ query: 'SELECT currentUser() AS u', format: 'JSONEachRow' });
  const rows = await rs.json();
  const u = rows[0] && rows[0].u;
  if (!u) throw new Error('could not determine currentUser()');
  return u;
}

/**
 * Resolve the room names for whoever this client is connected as.
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
  ROOM_TYPES, VIEW_TYPES, VIEW_PREFIX, viewName, perMemberEnabled, assertUsableMember,
  roomNames, currentUser, resolveRooms, mergeRooms,
};
