#!/usr/bin/env node
// mem — provision one member's rooms and grants. Idempotent; also the schema-rollout hook.
//
//   provision.js --member <name> [--merge] [--owner-grants]
//
// Run as the OWNER. Steps, all IF NOT EXISTS / re-runnable:
//   1. create the member's three rooms from schema-member.sql.tpl
//   2. grant the member their own three rooms, TWO statements each: MEMBER_PRIVS (not
//      re-grantable), then `SELECT WITH GRANT OPTION`. The split is the point —
//      MEMBER_PRIVS is exactly what the shipper uses and nothing that DEFINES an object,
//      and attaching grant-option to `SELECT` alone makes a share read-only by
//      construction. It is deliberately NOT `ALL`: that includes CREATE TABLE on the
//      member's own room name, which lets them replace the room with a Merge over every
//      member's and double the others' rows in the team room. See rooms.js.
//
//      THREE ROOMS, not four objects: the session rollup is a saved query over these
//      same rooms, not a stored view, so it needs no object and no grant of its own.
//   3. --merge: create/refresh the three Merge rooms, borrowing this member's columns
//   4. grant the member SELECT on whichever Merge rooms exist — a Merge reduces to the
//      rooms the caller can already read, so this is what makes the team room fail
//      CLOSED rather than deny outright
//
// Grants are explicit, per room, and NEVER `ON mem.*` — a member who can read the whole
// house can read every other member's rooms, which would make this a shared house with
// longer table names. No wildcards are used anywhere; the only pattern in the design is
// the Merge regex, anchored on a fixed room type.
//
// Env: MEM_URL / MEM_USER / MEM_PASSWORD / MEM_DB, falling back to MEMHOUSE_*. URL and
// USER are REQUIRED — see the note at cfg. MEM_DB defaults to 'mem'.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
// Named, not thrown as a raw MODULE_NOT_FOUND with a require stack. This runs as a
// SUBPROCESS of `memhouse install`, after the admin path has already created a ClickHouse
// user — so its failure mode is a half-provisioned house, and "Cannot find module" plus a
// stack trace is the least useful thing to print at that moment. Seen for real in a
// checkout where `npm install` had not been run.
let createClient, ClickHouseLogLevel;
try { ({ createClient, ClickHouseLogLevel } = require('@clickhouse/client')); }
catch {
  console.error("provision.js: dependency '@clickhouse/client' is not installed.");
  console.error(`  From a checkout:      npm install --prefix ${path.join(__dirname, '..', '..')}`);
  console.error(`  From an npm install:  ${require('./rooms').installCommand()}`);
  process.exit(2);
}
const { ROOM_TYPES, mergeRooms, assertUsableMember, MEMBER_PRIVS, MEMBER_PROFILE, MEMBER_PROFILE_SETTINGS } = require('./rooms');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

// Defaults MUST match what the shipper and CLI use, or an operator who overrides only
// the thing that differs — a password, say — silently provisions rooms in a house the
// product never reads, or fails to authenticate as a user that does not exist.
//
// Which is why there is no default URL or user any more, here either. This file CREATES
// USERS AND GRANTS; pointing it at a guessed http://localhost:8123 as memhouse_root aims
// the most privileged operation in the product at whatever house happens to be listening.
// Observed: running it with no env at all made an authentication attempt against the
// pilot's own ClickHouse.
const cfg = {
  url: process.env.MEM_URL || process.env.MEMHOUSE_URL,
  username: process.env.MEM_USER || process.env.MEMHOUSE_USER,
  password: process.env.MEM_PASSWORD || process.env.MEMHOUSE_PASSWORD || '',
  database: process.env.MEM_DB || process.env.MEMHOUSE_DB || 'mem',
};
if (!cfg.url || !cfg.username) {
  console.error('provision.js: no house given. Set MEM_URL and MEM_USER (or MEMHOUSE_URL/MEMHOUSE_USER).');
  console.error('  This creates users and grants — it will not guess http://localhost:8123 as memhouse_root.');
  process.exit(2);
}

// Statements are split on ';' at end of line — the templates contain no ';' inside a
// statement body, and keeping the splitter dumb keeps the templates readable.
function statements(sql) {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

/** Which of the three Merge rooms actually exist — a member may be provisioned first. */
async function mergeRoomsPresent(client, database) {
  const names = Object.values(mergeRooms());
  const rs = await client.query({
    query: `SELECT name FROM system.tables WHERE database = {db:String} AND name IN ({names:Array(String)}) ORDER BY name`,
    query_params: { db: database, names },
    format: 'JSONEachRow',
  });
  return (await rs.json()).map((r) => r.name);
}

async function main() {
  const member = opt('member');
  if (!member) { console.error('usage: provision.js --member <name> [--merge]'); process.exit(2); }
  assertUsableMember(member);

  const here = __dirname;

  // Create the house with a client that has NOT selected it — on a fresh server the
  // database does not exist yet, and selecting it fails before it can be created.
  // See the note in shipper/ship.js: the driver's ERROR-level dump buries every
  // refusal this file prints. MEMHOUSE_DEBUG=1 restores it.
  const quiet = { level: process.env.MEMHOUSE_DEBUG ? ClickHouseLogLevel.DEBUG : ClickHouseLogLevel.OFF };
  const bootstrap = createClient({ ...cfg, database: '', log: quiet });
  await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${cfg.database}` });
  await bootstrap.close();

  console.log(`[mem] provisioning in ${cfg.url} database '${cfg.database}' as '${cfg.username}'`);
  const client = createClient({ ...cfg, log: quiet, clickhouse_settings: { async_insert: 0 } });

  // 0. the member themselves.
  //
  // This file never created the ClickHouse user, so the path `memhouse install` prints and
  // INSTALL.md repeats — `provision.js --member <name> --merge` — created three rooms and
  // then died on `There is no role \`<name>\` in \`user directories\``, leaving orphan rooms
  // that nothing removes and that the --merge step then folded into all_sessions. It also
  // ignored --member-password. The documented second-member path did not work at all.
  const existing = await client.query({
    query: `SELECT name FROM system.users WHERE name = {n:String}`,
    query_params: { n: member }, format: 'JSONEachRow',
  });
  if ((await existing.json()).length === 0) {
    const pw = opt('member-password') || crypto.randomBytes(24).toString('base64url');
    await client.command({ query: `CREATE USER ${member} IDENTIFIED BY '${pw.replace(/'/g, "\\'")}'` });
    console.log(`[mem] created ClickHouse user '${member}'`);
    if (!opt('member-password')) {
      console.log(`[mem] password for '${member}': ${pw}`);
      console.log('[mem] shown once — hand it over, or pass --member-password next time');
    }
    console.log(`[mem] they finish with: memhouse install --url ${cfg.url} --db ${cfg.database} --user ${member} --password '…'`);
  } else {
    console.log(`[mem] ClickHouse user '${member}' already exists — provisioning rooms only`);
  }

  // 1. rooms
  const tpl = fs.readFileSync(path.join(here, 'schema-member.sql.tpl'), 'utf-8');
  const roomSql = statements(tpl.replaceAll('{{MEMBER}}', member));
  for (const q of roomSql) {
    // allow_experimental_full_text_index: a no-op on 26.x, required on 25.x for the
    // messages text indexes.
    await client.command({ query: q, clickhouse_settings: { allow_experimental_full_text_index: 1 } });
  }
  // CREATE TABLE IF NOT EXISTS is a no-op on an existing room, so re-running provision.js
  // over a room that has DRIFTED left it lossy while printing "rooms ready". The owner's
  // route has to heal as well as create — it is the one route that always holds the rights.
  {
    const { templateColumns } = require('../shipper/ship');
    const want = templateColumns(tpl);
    for (const ty of ROOM_TYPES) {
      const room = `${ty}_${member}`;
      const rs = await client.query({
        query: 'SELECT name FROM system.columns WHERE database = {d:String} AND table = {n:String}',
        query_params: { d: cfg.database, n: room }, format: 'JSONEachRow',
      });
      const have = new Set((await rs.json()).map((r) => r.name));
      if (!have.size) continue;
      for (const c of (want[ty] || [])) {
        if (have.has(c.name)) continue;
        await client.command({
          query: `ALTER TABLE ${cfg.database}.${room} ADD COLUMN IF NOT EXISTS ${c.name} ${c.type}`,
          clickhouse_settings: { allow_experimental_full_text_index: 1 },
        });
        console.log(`[mem] added missing column ${room}.${c.name}`);
      }
    }
  }
  console.log(`[mem] rooms ready for '${member}': ${ROOM_TYPES.map((t) => `${t}_${member}`).join(', ')}`);

  // 2. grants — two statements per room, and the split is the point.
  //
  // ALL, NOT re-grantable: the member owns their room outright, DROP and TRUNCATE
  // included, because it is their memory to destroy. It also covers the mutation
  // privileges the shipper needs without naming them — the shipper clears a session's
  // rows before re-inserting, and which of ALTER UPDATE / ALTER DELETE a server demands
  // varies by version (`DELETE FROM` is a lightweight delete, implemented as
  // `ALTER TABLE … UPDATE _row_exists = 0`, so 25.11 wants ALTER UPDATE where 26.7 wanted
  // ALTER DELETE). Granting one and not the other produces a pass that fails elsewhere.
  //
  // SELECT, re-grantable: a share is READ-ONLY BY CONSTRUCTION rather than by convention.
  // `GRANT ALL … WITH GRANT OPTION` expands to 45 privileges on 26.7 — DROP TABLE,
  // TRUNCATE, CREATE ROW POLICY, SYSTEM DROP REPLICA among them — and every one of those
  // would become something a member could hand to a colleague while meaning "let them
  // read my sessions". Measured: with this split, `GRANT SELECT … TO bob` succeeds and
  // `GRANT DROP TABLE … TO bob` is refused 497.
  // NOT `GRANT ALL`. On 26.7 that expands to 45 privileges including CREATE TABLE **on
  // the member's own room name** — which means a member owns the NAME, not just the data,
  // and can put any engine behind it. Measured on both versions:
  //
  //     DROP TABLE messages_alice;                                      -- allowed
  //     CREATE TABLE messages_alice AS all_messages
  //       ENGINE = Merge('<db>','^messages_');                          -- allowed
  //
  // `all_messages` is Merge(db,'^messages_'), so it then contains a Merge over its own
  // namespace and every OTHER member's rows are counted twice in the team room: a house
  // reading alice 6030 / bob 2401 / carol 12 became bob 4802 / carol 24, silently, no
  // error. Confidentiality survives — the Merge still narrows by grants, so alice reads
  // nothing new — but integrity does not, and a team-wide number is the whole point of
  // the room. SCHEMA.md already records the same failure reached by accident; this is the
  // same failure reachable on purpose by any member.
  //
  // So: the privileges the shipper actually uses, and nothing that lets a member define
  // an object. ALTER UPDATE and ALTER DELETE both, because `DELETE FROM` is a lightweight
  // delete implemented as `ALTER TABLE … UPDATE _row_exists = 0` and which of the two a
  // server demands varies by version (25.11 wants UPDATE where 26.7 wanted DELETE).
  // ALTER ADD COLUMN for ensureSchema's rollout. No CREATE TABLE, no DROP TABLE, no
  // TRUNCATE: the admin who provisioned the room is the one who can replace it.
  //
  // SELECT is re-grantable so a share is READ-ONLY BY CONSTRUCTION rather than by
  // convention — `GRANT SELECT … TO bob` succeeds, `GRANT DROP TABLE … TO bob` is 497.
  for (const t of ROOM_TYPES) {
    const room = `${cfg.database}.${t}_${member}`;
    await client.command({ query: `GRANT ${MEMBER_PRIVS} ON ${room} TO ${member}` });
    await client.command({ query: `GRANT SELECT ON ${room} TO ${member} WITH GRANT OPTION` });
  }
  console.log(`[mem] granted ${MEMBER_PRIVS} on 3 rooms to '${member}'; SELECT is the only re-grantable one`);

  // 2b. A settings profile with CEILINGS, not just defaults.
  //
  // Every isolation test passed on confidentiality and none existed for availability: a
  // member could `SETTINGS max_memory_usage=100000000000`, `max_execution_time=0` and
  // `max_threads=64` on a shared house, and take the server down for everyone. The
  // constraint form (`MAX`) is what makes it a ceiling — a plain default is advisory and a
  // member simply overrides it, which is what they were doing.
  //
  // Generous on purpose: a full re-ship of a large house is a big INSERT, and the point is
  // to stop one member exhausting the box, not to make honest work fail.
  try {
    await client.command({ query: `CREATE SETTINGS PROFILE OR REPLACE ${MEMBER_PROFILE} SETTINGS ${MEMBER_PROFILE_SETTINGS}` });
    await client.command({ query: `ALTER USER ${member} SETTINGS PROFILE '${MEMBER_PROFILE}'` });
    console.log(`[mem] settings profile '${MEMBER_PROFILE}' applied to '${member}' (memory, time and thread ceilings)`);
  } catch (e) {
    // A server where the admin cannot create profiles still gets a working member; say so
    // rather than failing the provision.
    console.log(`[mem] note: could not apply the '${MEMBER_PROFILE}' settings profile — ${e.message}`);
    console.log('[mem] the member works, but nothing bounds their query resources on this server');
  }

  // 3. Merge rooms
  if (flag('merge')) {
    const mtpl = fs.readFileSync(path.join(here, 'schema-merge.sql.tpl'), 'utf-8');
    for (const q of statements(mtpl.replaceAll('{{TEMPLATE_MEMBER}}', member))) {
      await client.command({ query: q });
    }
    console.log('[mem] merge rooms ready: all_sessions, all_messages, all_tool_calls');
  }

  // 4. Merge-room grants. Broad on purpose, and safe for the reason the whole layout
  // rests on: a Merge table reduces to the underlying rooms the CALLER holds grants for.
  // Measured on 25.11 — bob with SELECT on all_messages and nothing on messages_alice
  // reads his own row and none of alice's, with `_table` showing only messages_bob, and
  // no error. Withholding this grant does not make anything safer; it makes the team
  // room deny outright instead of failing closed, which is a different and worse thing.
  const merged = await mergeRoomsPresent(client, cfg.database);
  for (const room of merged) {
    await client.command({ query: `GRANT SELECT ON ${cfg.database}.${room} TO ${member}` });
  }
  if (merged.length) console.log(`[mem] granted SELECT on ${merged.join(', ')} to '${member}'`);
  else console.log('[mem] no merge rooms yet — run once with --merge to create them');

  await client.close();
}

main().catch((e) => { console.error(`[mem] provision failed: ${e.message}`); process.exit(1); });
