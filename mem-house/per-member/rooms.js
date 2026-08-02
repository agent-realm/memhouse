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
 * Resolve the room names for whoever this client is connected as.
 * Returns { sessions, messages, tool_calls, member, perMember }.
 */
async function resolveRooms(client) {
  if (!perMemberEnabled()) {
    return { sessions: 'sessions', messages: 'messages', tool_calls: 'tool_calls', member: null, perMember: false };
  }
  const rs = await client.query({ query: 'SELECT currentUser() AS u', format: 'JSONEachRow' });
  const rows = await rs.json();
  const member = rows[0] && rows[0].u;
  if (!member) throw new Error('could not determine currentUser() for per-member room resolution');
  assertUsableMember(member);
  const out = { member, perMember: true };
  for (const t of ROOM_TYPES) out[t] = `${t}_${member}`;
  return out;
}

/** The three Merge rooms — team-wide read paths, owner-managed. */
function mergeRooms() {
  return { sessions: 'all_sessions', messages: 'all_messages', tool_calls: 'all_tool_calls' };
}

module.exports = { ROOM_TYPES, perMemberEnabled, assertUsableMember, resolveRooms, mergeRooms };
