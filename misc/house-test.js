#!/usr/bin/env node
// House test — the shipper against a REAL, throwaway ClickHouse.
//
// `npm test` is pure JS: a syntax gate and unit tests over logic that needs no server.
// Nothing in it can see the class of defect that actually loses data here, because that
// class lives in the interaction between what the shipper writes and how
// ReplacingMergeTree collapses it. The stale-tail bug and its DELETE "fix" are both
// invisible to a test that never merges a part.
//
// So: one container, one house, fixture adapters, and assertions read back out of SQL.
//
//   node misc/house-test.js                     (defaults to 25.11)
//   MEMHOUSE_TEST_IMAGE=clickhouse/clickhouse-server:26.7 node misc/house-test.js
//   npm run test:house
//
// SAFETY, non-negotiable: this file NEVER connects to a house it did not start. The URL
// is built from a container port this process allocated, MEMHOUSE_HOME is a temp dir, and
// the container is removed with `-v` — the image declares a VOLUME on /var/lib/clickhouse
// and omitting -v orphans an anonymous volume per run.

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IMAGE = process.env.MEMHOUSE_TEST_IMAGE || 'clickhouse/clickhouse-server:25.11';
const NAME = `memhouse-house-test-${process.pid}`;
const DB = 'testhouse';
const USER = 'default';

// ── container lifecycle ─────────────────────────────────────────────────────────
function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf-8', ...opts }).trim();
}

function startHouse() {
  // Host port 0 = "let the kernel pick". A fixed port would eventually collide with a
  // real house — the pilot's own live at 8123 and 18999 — and this suite must be
  // incapable of reaching one.
  // CLICKHOUSE_SKIP_USER_SETUP=1: recent images mint a RANDOM password for `default`
  // unless told otherwise, and the entrypoint refuses to re-create `default` from
  // CLICKHOUSE_USER. Skipping user setup leaves the stock passwordless `default`, which is
  // right for a container reachable only on 127.0.0.1 and destroyed at the end of the run.
  docker(['run', '-d', '--name', NAME, '-p', '127.0.0.1:0:8123',
    '-e', `CLICKHOUSE_DB=${DB}`, '-e', 'CLICKHOUSE_SKIP_USER_SETUP=1',
    IMAGE], { stdio: ['ignore', 'pipe', 'pipe'] });
  const mapped = docker(['port', NAME, '8123']).split('\n')[0].trim();
  const port = Number(mapped.split(':').pop());
  assert.ok(port > 0 && port !== 8123 && port !== 18999, `refusing port ${port}`);
  return `http://127.0.0.1:${port}`;
}

async function waitReady(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${url}/ping`);
      if (r.ok && (await r.text()).trim() === 'Ok.') return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${IMAGE} did not answer /ping in 60s`);
}

function stopHouse() {
  try { docker(['rm', '-f', '-v', NAME], { stdio: 'ignore' }); } catch { /* already gone */ }
}

// ── fixture adapters ────────────────────────────────────────────────────────────
// Substituted into require.cache BEFORE ship.js is loaded: ship.js DESTRUCTURES
// getAllChats/getMessages at require time, so a stub installed afterwards is never seen.
const fixture = { chats: [] };
const editorsPath = require.resolve(path.join(ROOT, 'editors'));
require.cache[editorsPath] = {
  id: editorsPath, filename: editorsPath, loaded: true, children: [], paths: [],
  exports: {
    getAllChats: () => fixture.chats,
    getMessages: (chat) => chat._messages,
    getAdapterErrors: () => [],
    resetCaches: () => {},
    editors: [], editorLabels: {},
  },
};

const T0 = Date.parse('2026-08-16T09:00:00Z');

/**
 * One fixture session. `texts` become messages alternating user/assistant; an assistant
 * message carries a tool call so the tool_calls room is exercised by the same shrink.
 */
function chat(id, texts, { updatedAt = T0 + texts.length * 1000 } = {}) {
  return {
    source: 'claude',
    composerId: id,
    name: `fixture ${id}`,
    mode: 'agent',
    folder: '/tmp/fixture-project',
    createdAt: T0,
    lastUpdatedAt: updatedAt,
    bubbleCount: texts.length,
    _fullPath: `/tmp/fixture-${id}.jsonl`,
    _messages: texts.map((t, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: t,
      _ts: T0 + i * 1000,
      _model: i % 2 === 0 ? '' : 'claude-opus-5',
      _inputTokens: i % 2 === 0 ? 0 : 100,
      _outputTokens: i % 2 === 0 ? 0 : 50,
      ...(i % 2 === 1 ? { _toolCalls: [{ name: `Tool${i}`, args: { seq: i } }] } : {}),
    })),
  };
}

// ── test harness ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
async function test(name, fn) {
  if (only.length && !only.some((o) => name.includes(o))) return;
  try { await fn(); passed++; console.log(`ok    ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

async function main() {
  if (!process.env.MEMHOUSE_TEST_URL) {
    console.log(`[house-test] starting ${IMAGE} as ${NAME}`);
    process.env.MEMHOUSE_URL = startHouse();
  } else {
    process.env.MEMHOUSE_URL = process.env.MEMHOUSE_TEST_URL; // an already-running throwaway
  }
  await waitReady(process.env.MEMHOUSE_URL);

  // MEMHOUSE_HOME holds the host fingerprint the shipper mints. A temp one keeps the
  // pilot's real ~/.memhouse untouched and gives every run a fresh host id.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memhouse-house-test-'));
  process.env.MEMHOUSE_HOME = home;
  process.env.MEMHOUSE_USER = USER;
  process.env.MEMHOUSE_PASSWORD = '';
  process.env.MEMHOUSE_DB = DB;

  const { createClient } = require('@clickhouse/client');
  const { roomNames, READ_SETTINGS } = require(path.join(ROOT, 'memhouse/house/house'));
  const ship = require(path.join(ROOT, 'memhouse/shipper/ship'));

  const client = createClient({
    url: process.env.MEMHOUSE_URL, username: USER, password: '', database: DB,
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
  });
  const rooms = roomNames(USER);

  // Raw reads — the physical rows, whatever the read layer chooses to show.
  const raw = async (sql, params = {}) => (await (await client.query({
    query: sql, query_params: params, format: 'JSONEachRow',
  })).json());
  // Read-layer reads — exactly what a consumer sees, through the same room resolution
  // and settings the dashboard and MCP server use.
  const read = async (sql, params = {}) => (await (await client.query({
    query: sql.replace(/\{\{([a-z_]+)\}\}/g, (_, n) => rooms[n]),
    query_params: params, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })).json());

  await ship.ensureSchema(client);

  // ── the bug this task exists for ──────────────────────────────────────────────
  await test('a shorter re-parse must not destroy the content only the house still has', async () => {
    const id = 'shrink-1';
    fixture.chats = [chat(id, ['m1', 'm2', 'm3', 'SECRET draft I later deleted', 'another removed line'])];
    await ship.runShip(client, { full: true });

    const before = await raw(`SELECT text FROM messages FINAL WHERE session_id = {s:String} ORDER BY seq`,
      { s: `claude:${id}` });
    assert.strictEqual(before.length, 5, `first ship stored ${before.length} rows, expected 5`);

    // The source shrinks AND is rewritten in place — what Claude Code's compaction does.
    fixture.chats = [chat(id, ['m1 v2', 'm2 v2', 'm3 v2'], { updatedAt: T0 + 60000 })];
    await ship.runShip(client);

    const kept = new Set((await raw(
      `SELECT text FROM messages FINAL WHERE session_id = {s:String}`, { s: `claude:${id}` },
    )).map((r) => r.text));
    for (const gone of ['SECRET draft I later deleted', 'another removed line', 'm1', 'm2', 'm3']) {
      assert.ok(kept.has(gone), `'${gone}' is not in the house any more — it exists nowhere else`);
    }
  });

  await test('the read layer shows the current parse only — one row per message, no stale tail', async () => {
    const id = 'shrink-1'; // continues from the test above
    const rows = await read(`SELECT seq, text FROM {{messages}} WHERE session_id = {s:String} ORDER BY seq`,
      { s: `claude:${id}` });
    assert.deepStrictEqual(rows.map((r) => r.text), ['m1 v2', 'm2 v2', 'm3 v2'],
      `read layer returned ${rows.length} rows: ${JSON.stringify(rows.map((r) => r.text))}`);

    const roll = (await read(`SELECT total_msgs, input_tokens FROM {{sessions_v}} AS c WHERE session_id = {s:String}`,
      { s: `claude:${id}` }))[0];
    assert.strictEqual(Number(roll.total_msgs), 3, 'the rollup counts the superseded parse');
    assert.strictEqual(Number(roll.input_tokens), 100, 'token totals double-count the superseded parse');

    const sess = (await read(`SELECT message_count FROM {{sessions}} WHERE session_id = {s:String}`,
      { s: `claude:${id}` }))[0];
    assert.strictEqual(Number(sess.message_count), 3, 'message_count disagrees with the source');
  });

  await test('a shorter re-parse must not destroy superseded tool calls either', async () => {
    const id = 'shrink-1';
    const kept = (await raw(`SELECT tool_name FROM tool_calls FINAL WHERE session_id = {s:String}`,
      { s: `claude:${id}` })).map((r) => r.tool_name);
    assert.ok(kept.includes('Tool3'), `Tool3 was destroyed by the re-ship (kept: ${kept.join(',')})`);
    const shown = (await read(`SELECT tool_name FROM {{tool_calls}} WHERE session_id = {s:String} ORDER BY idx`,
      { s: `claude:${id}` })).map((r) => r.tool_name);
    assert.deepStrictEqual(shown, ['Tool1'], `read layer shows stale tool calls: ${shown.join(',')}`);
  });

  await test('the shipper runs no mutation — nothing it does needs ALTER DELETE', async () => {
    const muts = (await raw(`SELECT count() AS n FROM system.mutations WHERE database = {d:String}`, { d: DB }))[0];
    assert.strictEqual(Number(muts.n), 0, `${muts.n} mutation(s) ran — the shipper is still deleting`);
  });

  // ── the regression guard: 27,948 imported messages, lost once already ──────────
  await test('an imported row at an overlapping seq survives a re-ship', async () => {
    const id = 'import-1';
    const sid = `claude:${id}`;
    await client.insert({
      table: 'messages',
      values: [0, 1, 2].map((seq) => ({
        session_id: sid, seq, source: 'claude', host: 'imported-host',
        ts: '2026-08-01 00:00:00.000', role: 'user', text: `imported ${seq}`,
        origin: 'import', line_hash: '0', extra: {},
      })),
      format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 0 },
    });

    fixture.chats = [chat(id, ['s1', 's2', 's3', 's4'])];
    await ship.runShip(client, { full: true });
    fixture.chats = [chat(id, ['s1', 's2'], { updatedAt: T0 + 60000 })];
    await ship.runShip(client);

    const imported = await raw(
      `SELECT text FROM messages FINAL WHERE session_id = {s:String} AND origin = 'import' ORDER BY seq`,
      { s: sid });
    assert.deepStrictEqual(imported.map((r) => r.text), ['imported 0', 'imported 1', 'imported 2'],
      'a ship pass removed rows it did not write');
  });

  await test('a session that was forked settles again — the next pass skips it', async () => {
    // The epoch is bookkeeping the SHIPPER has to read back correctly, and getting it
    // wrong is not visible as an error: if the skip predicate counted rows across all
    // epochs, `intact` would never be true again and every compacted session would
    // re-ship on every pass forever, growing the house by one parse each time.
    const id = 'shrink-1';
    const first = await ship.runShip(client);
    assert.strictEqual(first.bumped, 0, 'an unchanged source forked the session again');
    const second = await ship.runShip(client);
    assert.strictEqual(second.bumped, 0);
    const epochs = await raw(
      `SELECT DISTINCT epoch FROM messages FINAL WHERE session_id = {s:String} ORDER BY epoch`,
      { s: `claude:${id}` });
    assert.deepStrictEqual(epochs.map((r) => Number(r.epoch)), [0, 1],
      'the house grew an epoch for a source that never changed');
  });

  await test('a compacted session — same length, rewritten head — keeps both parses', async () => {
    // Claude Code compaction rewrites a transcript in place. Bumping on shrink alone
    // would preserve the tail and still overwrite the rewritten head: the same loss,
    // through the merge instead of the delete.
    const id = 'compact-1';
    fixture.chats = [chat(id, ['c1 original', 'c2 original', 'c3 original'])];
    await ship.runShip(client, { full: true });
    fixture.chats = [chat(id, ['[compacted summary]', 'c2 original', 'c3 original'], { updatedAt: T0 + 60000 })];
    const r = await ship.runShip(client);
    assert.strictEqual(r.bumped, 1, 'a rewritten message did not fork the session');

    const kept = new Set((await raw(`SELECT text FROM messages FINAL WHERE session_id = {s:String}`,
      { s: `claude:${id}` })).map((x) => x.text));
    assert.ok(kept.has('c1 original'), 'the rewritten message destroyed the original');
    const shown = (await read(`SELECT text FROM {{messages}} WHERE session_id = {s:String} ORDER BY seq`,
      { s: `claude:${id}` })).map((x) => x.text);
    assert.deepStrictEqual(shown, ['[compacted summary]', 'c2 original', 'c3 original']);
  });

  await test('a parse that loses ALL its tool calls does not serve the old ones', async () => {
    // The room would answer max(epoch) with the SUPERSEDED epoch, because the new parse
    // wrote no rows into it at all — so the dashboard would show a current transcript
    // beside tool calls from a parse that no longer exists. tool_calls takes its epoch
    // from messages for exactly this reason.
    const id = 'notools-1';
    fixture.chats = [chat(id, ['t1', 't2 with a tool', 't3'])];
    await ship.runShip(client, { full: true });
    assert.ok((await read(`SELECT count() AS n FROM {{tool_calls}} WHERE session_id = {s:String}`,
      { s: `claude:${id}` }))[0].n > 0, 'fixture produced no tool calls to lose');

    // Rewritten, and every assistant turn is gone — what a compaction does.
    const flat = chat(id, ['t1 v2', 't2 v2', 't3 v2'], { updatedAt: T0 + 60000 });
    for (const m of flat._messages) { m.role = 'user'; delete m._toolCalls; }
    fixture.chats = [flat];
    await ship.runShip(client);

    const shown = await read(`SELECT tool_name FROM {{tool_calls}} WHERE session_id = {s:String}`,
      { s: `claude:${id}` });
    assert.strictEqual(shown.length, 0, `the read layer still shows ${shown.length} superseded tool call(s)`);
    // Still nothing destroyed: they are in the room, at the epoch they were written under.
    const kept = await raw(`SELECT tool_name FROM tool_calls FINAL WHERE session_id = {s:String}`,
      { s: `claude:${id}` });
    assert.ok(kept.length > 0, 'the superseded tool calls were destroyed rather than retained');
  });

  await test('a session that parses to zero messages is withheld, not written', async () => {
    // An adapter that swallows its own failure returns [] rather than throwing, which is
    // indistinguishable from a chat whose content really vanished — and writing it would
    // not even be self-consistent: with no rows at the new epoch, the read filter would
    // keep serving the superseded parse as if it were current.
    const id = 'empty-1';
    fixture.chats = [chat(id, ['e1', 'e2', 'e3'])];
    await ship.runShip(client, { full: true });
    const emptied = chat(id, [], { updatedAt: T0 + 60000 });
    fixture.chats = [emptied];
    const r = await ship.runShip(client);
    assert.strictEqual(r.withheld, 1, 'an empty re-parse was written instead of withheld');
    assert.strictEqual(r.bumped, 0, 'an empty re-parse forked the session');
    const shown = await read(`SELECT text FROM {{messages}} WHERE session_id = {s:String} ORDER BY seq`,
      { s: `claude:${id}` });
    assert.deepStrictEqual(shown.map((x) => x.text), ['e1', 'e2', 'e3'],
      'the stored transcript stopped being readable after an empty parse');
    const sess = (await read(`SELECT message_count FROM {{sessions}} WHERE session_id = {s:String}`,
      { s: `claude:${id}` }))[0];
    assert.strictEqual(Number(sess.message_count), 3, 'the session row was overwritten with 0');
  });

  // ── the common case must stay free ────────────────────────────────────────────
  await test('growth re-ships in place — an unchanged prefix costs no extra rows', async () => {
    const id = 'grow-1';
    fixture.chats = [chat(id, ['g1', 'g2'])];
    await ship.runShip(client, { full: true });
    fixture.chats = [chat(id, ['g1', 'g2', 'g3', 'g4'], { updatedAt: T0 + 60000 })];
    await ship.runShip(client);
    const rows = await raw(`SELECT seq FROM messages FINAL WHERE session_id = {s:String}`, { s: `claude:${id}` });
    assert.strictEqual(rows.length, 4,
      `${rows.length} physical rows for a 4-message session — appending must not fork the session`);
  });

  // ── the house's record of itself ──────────────────────────────────────────────
  await test('the house records its schema generation and who ships into it, once', async () => {
    const meta = new Map((await raw('SELECT key, value FROM house_meta FINAL')).map((r) => [r.key, r.value]));
    assert.strictEqual(meta.get('schema_version'), '2', 'the house does not know its schema generation');
    assert.strictEqual(meta.get(`client_version:${USER}`), require(path.join(ROOT, 'package.json')).version);

    const before = (await raw('SELECT count() AS n FROM house_events'))[0].n;
    assert.ok(Number(before) >= 2, `expected a schema and a version event, got ${before}`);
    // Written only on CHANGE. A row per pass would make this a heartbeat log — 288 a day
    // per machine under --loop — and bury the one question it exists to answer.
    await ship.runShip(client);
    const after = (await raw('SELECT count() AS n FROM house_events'))[0].n;
    assert.strictEqual(Number(after), Number(before), 'an unchanged pass wrote another event');
  });

  // ── the dashboard's own query layer ───────────────────────────────────────────
  await test('every dashboard query runs against the filtered rooms and counts one parse', async () => {
    // The read seam replaced a table NAME with a subquery in ~20 queries at once — joins,
    // aggregates, an IN-subquery filter, and a text search that matches on a MATERIALIZED
    // column `SELECT *` does not return. A syntax error in any of them would only show up
    // in the browser, so exercise the real module here.
    const queries = require(path.join(ROOT, 'memhouse/server/queries'));
    const overview = await queries.getOverview({});
    assert.ok(overview.totalChats > 0, 'the dashboard sees no sessions at all');

    await queries.getDailyActivity({});
    await queries.getDashboardStats({});
    await queries.getProjects({});
    await queries.getDeepAnalytics({});
    await queries.getToolCalls({});
    await queries.getCostAnalytics({});
    await queries.countChats({});

    // shrink-1 is the session that was forked: 5 messages at epoch 0, 3 at epoch 1. The
    // dashboard must report 3 — an unfiltered read would say 8, which is worse than the
    // stale tail this design replaced.
    const chats = await queries.getChats({ chatId: 'claude:shrink-1' });
    assert.strictEqual(chats.length, 1, `expected one session row, got ${chats.length}`);
    assert.strictEqual(Number(chats[0].bubbleCount), 3,
      `the dashboard counts ${chats[0].bubbleCount} messages for a 3-message session`);
    // Cost is derived from the token sums, so a superseded parse would inflate money as
    // well as counts: one assistant turn at 100 in / 50 out, not two.
    assert.ok(chats[0].cost > 0 && chats[0].cost < 0.002, `cost reads ${chats[0].cost}`);

    const chat = await queries.getChat(chats[0].id);
    assert.strictEqual(chat.messages.length, 3, 'the transcript view shows a superseded parse');
    assert.ok(!chat.messages.some((m) => m.content.includes('SECRET draft')),
      'the transcript view shows rows from an earlier parse');
  });

  // ── migrating a house built by 0.9.0 ──────────────────────────────────────────
  await test('migrate-rooms rebuilds a pre-epoch house without losing a row or restamping one', async () => {
    const db = 'oldhouse';
    const exec = async (sql, settings = '') => {
      const res = await fetch(`${process.env.MEMHOUSE_URL}/?database=${db}${settings}`, { method: 'POST', body: sql });
      const text = await res.text();
      if (!res.ok) throw new Error(text.trim().split('\n')[0]);
      return text.trim();
    };
    await fetch(`${process.env.MEMHOUSE_URL}/`, { method: 'POST', body: `CREATE DATABASE IF NOT EXISTS ${db}` });
    // 0.9.0's shape: origin in the key, no epoch anywhere.
    await exec(`CREATE TABLE messages (
        session_id String, seq UInt32, source LowCardinality(String), host LowCardinality(String),
        ts DateTime64(3,'UTC'), role LowCardinality(String), model LowCardinality(String) DEFAULT '',
        input_tokens UInt64 DEFAULT 0, output_tokens UInt64 DEFAULT 0,
        cache_read_tokens UInt64 DEFAULT 0, cache_write_tokens UInt64 DEFAULT 0,
        text String, project String DEFAULT '', folder String DEFAULT '',
        is_subagent Bool DEFAULT false, extra JSON, line_hash UInt64,
        origin LowCardinality(String) DEFAULT 'ship',
        user_id String MATERIALIZED currentUser(),
        ingested_at DateTime64(3,'UTC') DEFAULT now64(3)
      ) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (session_id, user_id, origin, seq)`);
    await exec("CREATE TABLE sessions (session_id String, source LowCardinality(String), host LowCardinality(String), name String DEFAULT '', mode LowCardinality(String) DEFAULT '', folder String DEFAULT '', project String DEFAULT '', git_branch String DEFAULT '', created_at Nullable(DateTime64(3,'UTC')), last_updated_at Nullable(DateTime64(3,'UTC')), message_count UInt32 DEFAULT 0, path String DEFAULT '', extra JSON, origin LowCardinality(String) DEFAULT 'ship', user_id String MATERIALIZED currentUser(), ingested_at DateTime64(3,'UTC') DEFAULT now64(3)) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (session_id, user_id)");
    await exec("CREATE TABLE tool_calls (session_id String, seq UInt32, idx UInt32, source LowCardinality(String), host LowCardinality(String), tool_name LowCardinality(String), args String DEFAULT '{}', ts DateTime64(3,'UTC'), project String DEFAULT '', folder String DEFAULT '', origin LowCardinality(String) DEFAULT 'ship', user_id String MATERIALIZED currentUser(), ingested_at DateTime64(3,'UTC') DEFAULT now64(3)) ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (session_id, user_id, origin, idx)");
    // Two writers, and one of them is NOT the account running the migration. user_id is
    // MATERIALIZED currentUser(), so a naive INSERT SELECT would rewrite every one of
    // these rows to say `default` — silently reassigning who said what in a shared house.
    await exec(`INSERT INTO messages (session_id, seq, source, host, ts, role, text, line_hash, extra, user_id) VALUES
      ('old:1', 0, 'claude', 'h', now64(3), 'user', 'mine', 0, '{}', 'default'),
      ('old:1', 1, 'claude', 'h', now64(3), 'user', 'also mine', 0, '{}', 'default'),
      ('old:2', 0, 'codex', 'h', now64(3), 'user', 'a housemate wrote this', 0, '{}', 'housemate')`,
    '&insert_allow_materialized_columns=1');

    const out = execFileSync(process.execPath,
      [path.join(ROOT, 'bin', 'memhouse.js'), 'migrate-rooms', '--yes'],
      { encoding: 'utf-8', env: { ...process.env, MEMHOUSE_DB: db } });
    assert.match(out, /house is at schema 2/, out);

    const key = await exec("SELECT sorting_key FROM system.tables WHERE database = 'oldhouse' AND name = 'messages'");
    assert.strictEqual(key, 'session_id, user_id, origin, epoch, seq');
    const rows = (await exec('SELECT user_id, text FROM messages FINAL ORDER BY session_id, seq FORMAT JSONEachRow'))
      .split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 3, 'the migration lost a row');
    assert.strictEqual(rows[2].user_id, 'housemate', 'the migration restamped a housemate\'s rows as its own');
    // Nothing deleted: the old room is still there, under a name that says what it is.
    const keptRows = await exec("SELECT count() FROM messages_pre_epoch");
    assert.strictEqual(keptRows, '3');
    const ev = await exec("SELECT status FROM house_events WHERE kind = 'migration' AND id = '0100-epoch-key' ORDER BY event_at DESC LIMIT 1");
    assert.strictEqual(ev, 'applied');
    // And it is idempotent: a second run finds nothing to do rather than rebuilding again.
    const again = execFileSync(process.execPath,
      [path.join(ROOT, 'bin', 'memhouse.js'), 'migrate-rooms', '--yes'],
      { encoding: 'utf-8', env: { ...process.env, MEMHOUSE_DB: db } });
    assert.match(again, /already carries the schema 2 sorting key/, again);
  });

  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed  (${IMAGE})`);
  process.exitCode = failed ? 1 : 0;
}

process.on('exit', stopHouse);
process.on('SIGINT', () => { stopHouse(); process.exit(130); });
main().catch((e) => { console.error(e); stopHouse(); process.exit(1); });
