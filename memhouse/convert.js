// Convert a pre-one-layout house to the one layout — the plan, as SQL, pure.
//
// Before 0.18 every member owned a DATABASE named for them: `polat.messages`,
// `polat.house_meta`, granted ALL ON polat.*. The one layout puts everyone in one database
// as `mem.polat_messages`, `mem.polat_meta`, with one wildcard grant and nothing on the
// database itself. Moving is a RENAME per table — metadata only, nothing copied — plus the
// grant swap, and shares re-expressed on the new names. The 0.17.1 dashboard views are
// dropped: in the one layout the shipper fills the stat tables (a refreshable view needs
// CREATE TABLE on the whole database, the grant this layout withholds).
//
// The operator runs it once, as an admin. Members then `memhouse update`; the new build
// finds the moved rooms and repairs its own env (see adoptMovedHouse in the CLI and shipper).

const { roomPattern, physicalRoom, ROOM_TYPES, META_TYPES, MEMBER_PIN } = require('./house/house');
const { roomGrant } = require('./provision');

const LEGACY = { messages: 'messages', sessions: 'sessions', tool_calls: 'tool_calls', meta: 'house_meta', events: 'house_events' };
const STAT_VIEWS = ['session_stats_mv', 'session_model_stats_mv', 'session_tool_stats_mv'];
const STAT_TABLES = ['session_stats', 'session_model_stats', 'session_tool_stats'];

/**
 * @param {object} p
 * @param {string} p.member            the member (= the old database name)
 * @param {string} [p.db='mem']        the one-layout house
 * @param {Array<{reader:string}>} [p.shares]        whole-house reads granted to others (SELECT ON member.*)
 * @param {Array<{name:string, table:string, filter:string, readers:string[]}>} [p.policies]  row policies on the old tables
 * @returns {Array<{sql:string, why:string, optional?:boolean, when?:string}>}
 */
function planMember({ member, db = 'mem', shares = [], policies = [] }) {
  const steps = [];
  for (const v of STAT_VIEWS) steps.push({ sql: `DROP TABLE IF EXISTS ${member}.${v}`, why: '0.17.1 refreshable view — the shipper fills stats in the one layout' });
  for (const t of STAT_TABLES) steps.push({ sql: `DROP TABLE IF EXISTS ${member}.${t}`, why: '0.17.1 stat table — recreated by the member\'s next ship in the new shape' });
  const pairs = [...ROOM_TYPES, ...META_TYPES].map((t) => `${member}.${LEGACY[t]} TO ${db}.${physicalRoom(t, member)}`);
  steps.push({ sql: `RENAME TABLE ${pairs.join(', ')}`, why: 'the five rooms move into the house under the member\'s name — one atomic rename, nothing copied' });
  steps.push({ sql: `REVOKE ALL ON ${member}.* FROM ${member}`, why: 'the database-wide grant the old layout needed' });
  steps.push({ sql: roomGrant(db, member), why: `their rooms — ${db}.${roomPattern(member)} — and nothing else` });
  steps.push({ sql: `ALTER USER ${member} ADD SETTING ${MEMBER_PIN}`, why: 'user_id is stamped per row; async inserts would skip it', optional: true });
  steps.push({ sql: `GRANT ALTER USER ON ${member} TO ${member}`, why: '`memhouse passwd` without an admin', optional: true });
  steps.push({ sql: `GRANT SHOW USERS ON *.* TO ${member}`, why: 'names only, to know who to share with', optional: true });
  steps.push({ sql: `GRANT REMOTE ON *.* TO ${member}`, why: '`memhouse relocate`', optional: true });
  for (const s of shares) {
    steps.push({ sql: `REVOKE SELECT ON ${member}.* FROM ${s.reader}`, why: `${s.reader}'s read of the old database`, optional: true });
    steps.push({ sql: `GRANT SELECT ON ${db}.${roomPattern(member)} TO ${s.reader}`, why: `${s.reader} keeps reading ${member}'s rooms`, optional: true });
  }
  for (const p of policies) {
    const type = Object.keys(LEGACY).find((k) => LEGACY[k] === p.table) || null;
    if (!type) continue;
    const readers = p.readers.length ? p.readers.join(', ') : 'ALL';
    steps.push({ sql: `CREATE ROW POLICY OR REPLACE ${p.name} ON ${db}.${physicalRoom(type, member)} FOR SELECT USING ${p.filter} TO ${readers}`, why: `row policy '${p.name}' follows the room`, optional: true });
    steps.push({ sql: `DROP ROW POLICY IF EXISTS ${p.name} ON ${member}.${p.table}`, why: 'its copy on the old name', optional: true });
  }
  steps.push({ sql: `DROP DATABASE IF EXISTS ${member}`, why: 'the emptied database', when: 'empty' });
  return steps;
}

function render(steps) {
  return steps.map((s) => `-- ${s.why}${s.optional ? ' (optional)' : ''}${s.when ? ` (only when ${s.when})` : ''}\n${s.sql};`).join('\n');
}

module.exports = { planMember, render, LEGACY, STAT_VIEWS, STAT_TABLES };
