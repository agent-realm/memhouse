// Provisioning a member — THE plan, whether memhouse executes it or a DBA does.
//
// There used to be three copies of this: the live path (adminBootstrap), the printed one
// (--print-sql), and install --admin-user. They drifted, and the printed copy handed a
// non-admin the one configuration the live path refuses — found in a drill, not by a
// test. A plan that is data cannot drift from itself: the live path executes it,
// --print-sql prints it, and the unit tests assert on it.
//
// The plan is a member and a database, and its centre is one statement:
//
//   GRANT <room privileges> ON <db>.<member>_* TO <member> WITH GRANT OPTION
//
// A wildcard on the member's own name. It covers rooms that do not exist yet, so the
// member's shipper creates their rooms itself, a schema rebuild can CREATE and EXCHANGE
// inside the pattern, and a share can name the whole set or one table. It reaches nothing
// outside the pattern — measured on 26.7: a member cannot create, read, list, drop or
// re-grant a housemate's rooms — and a colleague can read it back with SHOW GRANTS in one
// line, which is the property the whole product rests on.
//
// Nobody is ever granted ALL ON <db>.*. That grant is dynamic (it covers rooms created
// later), and it is what turned two members in one database into a leak.

const { MEMBER_PIN, assertUsableName, roomPattern } = require('./house/house');

/**
 * What a member may do inside their own pattern. Each entry earns its place:
 *   SELECT, INSERT           the shipper writes, everything else reads
 *   ALTER, OPTIMIZE          ensureSchema adds columns in place; doctor compacts
 *   CREATE TABLE, DROP TABLE their own rooms on first ship; a rebuild on migrate
 *   ROW POLICY *             `share --only` scopes a grantee to a project or a session
 */
const ROOM_PRIVILEGES = [
  'SELECT', 'INSERT', 'ALTER', 'OPTIMIZE',
  'CREATE TABLE', 'DROP TABLE',
  'CREATE ROW POLICY', 'ALTER ROW POLICY', 'DROP ROW POLICY', 'SHOW ROW POLICIES',
];

function roomGrant(db, member) {
  return `GRANT ${ROOM_PRIVILEGES.join(', ')} ON ${db}.${roomPattern(member)} TO ${member} WITH GRANT OPTION`;
}

function sqlString(v) {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The statements that make `member` a member of house `db`, in order.
 *
 * `optional` marks steps that need ACCESS MANAGEMENT the admin may not hold. The live
 * path skips those on refusal and says what the member loses; a refused required step
 * aborts. `password` may be null for a member that already exists (an invite re-run, an
 * install against an account the DBA made) — then the CREATE USER step is omitted and the
 * rest still applies.
 *
 * @returns {Array<{sql:string, why:string, optional:boolean}>}
 */
function plan({ db, member, password = null }) {
  assertUsableName(db, 'house');
  assertUsableName(member, 'member');
  const steps = [
    { sql: `CREATE DATABASE IF NOT EXISTS ${db}`, why: 'the house', optional: false },
  ];
  if (password !== null) {
    steps.push({ sql: `CREATE USER IF NOT EXISTS ${member} IDENTIFIED BY ${sqlString(password)}`, why: 'the member', optional: false });
  }
  steps.push(
    { sql: roomGrant(db, member), why: `their rooms — ${db}.${roomPattern(member)} — and nothing else in the house`, optional: false },
    { sql: `ALTER USER ${member} ADD SETTING ${MEMBER_PIN}`, why: 'user_id is stamped on every row; an async insert would skip the stamp', optional: false },
    { sql: `GRANT ALTER USER ON ${member} TO ${member}`, why: '`memhouse passwd` without an admin (their own account only)', optional: true },
    { sql: `GRANT SHOW USERS ON *.* TO ${member}`, why: 'see who to share with — names only, never data', optional: true },
    { sql: `GRANT REMOTE ON *.* TO ${member}`, why: '`memhouse relocate` pulls the old house over remoteSecure()', optional: true },
  );
  return steps;
}

/**
 * The plan as SQL a person runs — clickhouse-client, the play UI, curl. One statement per
 * line so it can be split on ';' by anything, comments above each saying why.
 */
function render(steps, { db, member }) {
  const out = [
    `-- memhouse: make '${member}' a member of house '${db}'.`,
    '-- Run as a user with ACCESS MANAGEMENT (a stock \'default\' with access_management=1 will do).',
    '--',
    `-- One grant, on ${db}.${roomPattern(member)}: their rooms and nothing else in the database.`,
    '-- Housemates keep their own rooms beside these and cannot read them. Do NOT widen it to',
    `-- ${db}.* — that reaches every housemate's rooms, present and future.`,
    '--',
    `-- Their rooms are created by their own first \`memhouse ship\`; nothing to pre-build.`,
    '',
  ];
  for (const s of steps) {
    out.push(`-- ${s.why}${s.optional ? '  (optional: needs ACCESS MANAGEMENT; skip if refused)' : ''}`);
    out.push(`${s.sql};`);
    out.push('');
  }
  return out.join('\n');
}

module.exports = { ROOM_PRIVILEGES, roomGrant, plan, render };
