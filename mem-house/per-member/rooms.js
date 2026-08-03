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

function perMemberEnabled() {
  return process.env.MEM_PER_MEMBER === '1';
}

// ClickHouse usernames are permissive; room names are not. Refuse anything that would
// need quoting or could change how a Merge regex or a name-splitter reads.
function assertUsableMember(member) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(member)) {
    throw new Error(`cannot build room names for user '${member}': expected [A-Za-z][A-Za-z0-9_]*`);
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
  for (const t of [...ROOM_TYPES, ...VIEW_TYPES]) out[t] = `${t}_${member}`;
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
  ROOM_TYPES, VIEW_TYPES, perMemberEnabled, assertUsableMember, roomNames, currentUser,
  resolveRooms, mergeRooms,
};
