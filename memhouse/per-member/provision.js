#!/usr/bin/env node
// mem — provision one member's rooms and grants. Idempotent; also the schema-rollout hook.
//
//   provision.js --member <name> [--merge] [--owner-grants]
//
// Run as the OWNER. Steps, all IF NOT EXISTS / re-runnable:
//   1. create the member's three rooms from schema-member.sql.tpl
//   2. grant the member their own three rooms, TWO statements each: `ALL` (not
//      re-grantable), then `SELECT WITH GRANT OPTION`. The split is the point —
//      `ALL` covers the mutation privileges the shipper's clear-then-insert needs
//      without naming them, and attaching grant-option to `SELECT` alone makes a share
//      read-only by construction. See the notes at the grants themselves.
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
// Env: MEM_URL / MEM_USER / MEM_PASSWORD / MEM_DB, falling back to MEMHOUSE_* and then
// to the shipper's own defaults — http://localhost:8123, memhouse_root, mem.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@clickhouse/client');
const { ROOM_TYPES, mergeRooms, assertUsableMember } = require('./rooms');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

// Defaults MUST match what the shipper and CLI use, or an operator who overrides only
// the thing that differs — a password, say — silently provisions rooms in a house the
// product never reads, or fails to authenticate as a user that does not exist.
const cfg = {
  url: process.env.MEM_URL || process.env.MEMHOUSE_URL || 'http://localhost:8123',
  username: process.env.MEM_USER || process.env.MEMHOUSE_USER || 'memhouse_root',
  password: process.env.MEM_PASSWORD || process.env.MEMHOUSE_PASSWORD || '',
  database: process.env.MEM_DB || process.env.MEMHOUSE_DB || 'mem',
};

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
  const bootstrap = createClient({ ...cfg, database: '' });
  await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${cfg.database}` });
  await bootstrap.close();

  console.log(`[mem] provisioning in ${cfg.url} database '${cfg.database}' as '${cfg.username}'`);
  const client = createClient({ ...cfg, clickhouse_settings: { async_insert: 0 } });

  // 1. rooms
  const tpl = fs.readFileSync(path.join(here, 'schema-member.sql.tpl'), 'utf-8');
  const roomSql = statements(tpl.replaceAll('{{MEMBER}}', member));
  for (const q of roomSql) {
    // allow_experimental_full_text_index: a no-op on 26.x, required on 25.x for the
    // messages text indexes.
    await client.command({ query: q, clickhouse_settings: { allow_experimental_full_text_index: 1 } });
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
  for (const t of ROOM_TYPES) {
    const room = `${cfg.database}.${t}_${member}`;
    await client.command({ query: `GRANT ALL ON ${room} TO ${member}` });
    await client.command({ query: `GRANT SELECT ON ${room} TO ${member} WITH GRANT OPTION` });
  }
  console.log(`[mem] granted ALL on 3 rooms to '${member}'; SELECT is the only re-grantable one`);

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
