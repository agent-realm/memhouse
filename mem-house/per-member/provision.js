#!/usr/bin/env node
// mem — provision one member's rooms and grants. Idempotent; also the schema-rollout hook.
//
//   provision.js --member <name> [--merge] [--owner-grants]
//
// Run as the OWNER. Steps, all IF NOT EXISTS / re-runnable:
//   1. create the member's three rooms from schema-member.sql.tpl
//   2. grant the member SELECT, INSERT, ALTER UPDATE, ALTER DELETE on those three rooms,
//      WITH GRANT OPTION (grant-option is what makes whole-room sharing self-serve; the
//      two ALTER grants are required by the shipper's clear-then-insert, not a
//      convenience — see the note at the grant itself)
//   3. --merge: create/refresh the three Merge rooms, borrowing this member's columns
//
// Grants are explicit, one statement per room. No wildcards are used anywhere; the only
// pattern in the design is the Merge regex, anchored on a fixed room type.
//
// Env: MEM_URL / MEM_USER / MEM_PASSWORD / MEM_DB (defaults mirror the shipper's).

const fs = require('fs');
const path = require('path');
const { createClient } = require('@clickhouse/client');
const { ROOM_TYPES, VIEW_TYPES, viewName, assertUsableMember } = require('./rooms');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const cfg = {
  url: process.env.MEM_URL || process.env.MEMHOUSE_URL || 'http://localhost:8123',
  username: process.env.MEM_USER || process.env.MEMHOUSE_USER || 'mem_root',
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

  // 2. grants — explicit, one per room
  for (const t of ROOM_TYPES) {
    await client.command({
      // The mutation grants are required, not optional: the shipper clears a known
      // session's rows before re-inserting so a shorter re-parse cannot leave stale seq
      // tails. BOTH are needed, and which one bites depends on the server version —
      // `DELETE FROM` is a *lightweight* delete, implemented as
      // `ALTER TABLE ... UPDATE _row_exists = 0`, so 25.11 demands
      // `ALTER UPDATE(_row_exists)` while 26.7 asked for `ALTER DELETE`. Granting one
      // produces a pass that fails on the other server, so grant both.
      query: `GRANT SELECT, INSERT, ALTER UPDATE, ALTER DELETE ON ${cfg.database}.${t}_${member} TO ${member} WITH GRANT OPTION`,
    });
  }
  // The view is read-only and read by the dashboard/CLI, so SELECT is the whole grant —
  // with grant option, because sharing a room without its view leaves the recipient able
  // to read rows and unable to use any of the product's read paths.
  for (const v of VIEW_TYPES) {
    await client.command({
      query: `GRANT SELECT ON ${cfg.database}.${viewName(v, member)} TO ${member} WITH GRANT OPTION`,
    });
  }
  console.log(`[mem] granted SELECT, INSERT, ALTER UPDATE, ALTER DELETE WITH GRANT OPTION on 3 rooms to '${member}'`);
  console.log(`[mem] granted SELECT WITH GRANT OPTION on ${VIEW_TYPES.map((v) => viewName(v, member)).join(', ')}`);

  // 3. Merge rooms
  if (flag('merge')) {
    const mtpl = fs.readFileSync(path.join(here, 'schema-merge.sql.tpl'), 'utf-8');
    for (const q of statements(mtpl.replaceAll('{{TEMPLATE_MEMBER}}', member))) {
      await client.command({ query: q });
    }
    console.log('[mem] merge rooms ready: all_sessions, all_messages, all_tool_calls');
  }

  await client.close();
}

main().catch((e) => { console.error(`[mem] provision failed: ${e.message}`); process.exit(1); });
