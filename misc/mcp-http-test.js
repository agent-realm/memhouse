#!/usr/bin/env node
// Live battery for MCP over Streamable HTTP: a throwaway ClickHouse, the REAL
// dashboard server process (memhouse/server/server.js — the MCP endpoint mounts on
// it, no new daemon), and raw fetch() against POST /mcp. Not part of `npm test`
// (needs docker); run directly:
//
//   node misc/mcp-http-test.js
//
// What must hold, beyond the tool behavior the stdio battery already proves:
//   * header↔body validation — Mcp-Method / Mcp-Name / MCP-Protocol-Version each
//     checked against the body, mismatch or absence (modern era) => 400 -32020,
//     base64-sentinel Mcp-Name decoded before comparing
//   * Origin validated => 403 for non-local pages (DNS-rebinding defense)
//   * unknown method => HTTP 404 with -32601; unsupported version => 400 -32022
//   * GET/DELETE => 405; Mcp-Session-Id ignored and never echoed; notifications => 202
//   * legacy clients (no modern version pair) still served, dual-era
//   * the credential appears in no HTTP response body

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CH_PORT = 19753;
const HTTP_PORT = 19754;
const NAME = 'mh-mcp-http-test';
const PASS = 'http-test-secret-pw';
const CH = `http://127.0.0.1:${CH_PORT}`;
const MCP = `http://127.0.0.1:${HTTP_PORT}/mcp`;
const MODERN = '2026-07-28';
const META = 'io.modelcontextprotocol/';
const MODERN_META = { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {} };

function sh(cmd, args) { return spawnSync(cmd, args, { encoding: 'utf8' }); }

async function chq(sql, { retries = 0, db = 'mem' } = {}) {
  const res = await fetch(`${CH}/?allow_experimental_full_text_index=1${db ? `&database=${db}` : ''}`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`default:${PASS}`).toString('base64') },
    body: sql,
  }).catch((e) => ({ ok: false, text: async () => String(e) }));
  const text = await res.text();
  if (!res.ok) {
    if (retries > 0) { await new Promise((r) => setTimeout(r, 1000)); return chq(sql, { retries: retries - 1, db }); }
    throw new Error(`clickhouse refused: ${text.slice(0, 200)}`);
  }
  return text;
}

// One POST to the MCP endpoint; returns { status, body (parsed or raw), headers }.
let nextId = 1;
async function post(msg, { headers = {}, auto = true } = {}) {
  const withId = msg.id === null
    ? (({ id, ...rest }) => ({ jsonrpc: '2.0', ...rest }))(msg)
    : { jsonrpc: '2.0', id: nextId++, ...msg };
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  if (auto) {
    h['MCP-Protocol-Version'] = MODERN;
    h['Mcp-Method'] = withId.method;
    if (withId.method === 'tools/call') h['Mcp-Name'] = withId.params.name;
    withId.params = { ...(withId.params || {}), _meta: MODERN_META };
  }
  const res = await fetch(MCP, { method: 'POST', headers: h, body: JSON.stringify(withId) });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers, raw: text };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  sh('docker', ['rm', '-f', '-v', NAME]);
  const up = sh('docker', ['run', '-d', '--name', NAME, '-p', `127.0.0.1:${CH_PORT}:8123`,
    '-e', `CLICKHOUSE_PASSWORD=${PASS}`, 'clickhouse/clickhouse-server:latest']);
  if (up.status !== 0) { console.error(`docker run failed: ${up.stderr}`); process.exit(1); }
  let server = null;

  try {
    await chq('SELECT 1', { retries: 30, db: '' });
    await chq('CREATE DATABASE IF NOT EXISTS mem', { db: '' });
    const tpl = fs.readFileSync(path.join(ROOT, 'memhouse', 'house', 'schema.sql.tpl'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of tpl.split(';').map((s) => s.trim()).filter(Boolean)) await chq(stmt);
    await chq(`INSERT INTO sessions (session_id, source, host, name, folder, project, origin, message_count) VALUES
      ('claude-code:99999999-8888-7777-6666-555555555555', 'claude-code', 'mac1', 'the pelican refactor', '/tmp/pelican', 'pelican', 'ship', 2)`);
    await chq(`INSERT INTO messages (session_id, seq, source, host, ts, role, model, text, project, folder, origin, line_hash) VALUES
      ('claude-code:99999999-8888-7777-6666-555555555555', 1, 'claude-code', 'mac1', '2026-08-15 12:00:00', 'user', '', 'refactor the pelican-nesting-module now', 'pelican', '/tmp/pelican', 'ship', 1),
      ('claude-code:99999999-8888-7777-6666-555555555555', 2, 'claude-code', 'mac1', '2026-08-15 12:00:30', 'assistant', 'claude-opus-5', 'done, nesting extracted', 'pelican', '/tmp/pelican', 'ship', 2)`);

    // The real dashboard server, MCP endpoint mounted on it.
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memhouse-mcp-http-'));
    server = spawn('node', [path.join(ROOT, 'memhouse', 'server', 'server.js')], {
      env: {
        ...process.env,
        MEMHOUSE_URL: CH, MEMHOUSE_USER: 'default', MEMHOUSE_PASSWORD: PASS,
        MEMHOUSE_DB: 'mem', MEMHOUSE_HOME: HOME, MEMHOUSE_PORT: String(HTTP_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 30; i++) {
      try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/ping`); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }

    const SID = 'claude-code:99999999-8888-7777-6666-555555555555';

    await test('modern discover → 200, modern shape', async () => {
      const r = await post({ method: 'server/discover', params: {} });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.result.supportedVersions, [MODERN]);
      assert.strictEqual(r.body.result._meta[`${META}serverInfo`].name, 'memhouse');
    });

    await test('a full modern tool flow over HTTP: list → search → get_session', async () => {
      const list = await post({ method: 'tools/list', params: {} });
      assert.deepStrictEqual(list.body.result.tools.map((t) => t.name),
        ['search', 'sessions', 'get_session', 'status', 'users', 'resume_command', 'sql']);
      const hits = JSON.parse((await post({ method: 'tools/call', params: { name: 'search', arguments: { q: 'pelican-nesting' } } })).body.result.content[0].text);
      assert.strictEqual(hits.matches, 1);
      assert.strictEqual(hits.results[0].session_id, SID);
      const full = JSON.parse((await post({ method: 'tools/call', params: { name: 'get_session', arguments: { session_id: SID } } })).body.result.content[0].text);
      assert.strictEqual(full.messages.length, 2);
    });

    await test('Mcp-Method mismatching the body is 400 -32020 — the balancer/body split is an attack', async () => {
      const r = await post({ method: 'tools/list', params: {} }, {
        auto: false,
        headers: { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call' },
      });
      // body carries no _meta here; the header alone makes the request modern
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error.code, -32020);
    });

    await test('a modern body without the version header is 400 -32020, not silently served', async () => {
      const r = await post({ method: 'tools/list', params: { _meta: MODERN_META } }, { auto: false });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error.code, -32020);
      assert.ok(/MCP-Protocol-Version/.test(r.body.error.message));
    });

    await test('Mcp-Name must match params.name for tools/call; the base64 sentinel decodes first', async () => {
      const mk = (name) => post({ method: 'tools/call', params: { name: 'search', arguments: { q: 'x' }, _meta: MODERN_META } }, {
        auto: false,
        headers: { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
      });
      const wrong = await mk('sql');
      assert.strictEqual(wrong.status, 400);
      assert.strictEqual(wrong.body.error.code, -32020);
      const missing = await post({ method: 'tools/call', params: { name: 'search', arguments: { q: 'x' }, _meta: MODERN_META } }, {
        auto: false, headers: { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call' },
      });
      assert.strictEqual(missing.body.error.code, -32020);
      const encoded = await mk(`=?base64?${Buffer.from('search').toString('base64')}?=`);
      assert.strictEqual(encoded.status, 200, 'an encoded Mcp-Name that decodes to the body value passes');
    });

    await test('an unknown version in the header is 400 -32022 with the supported list', async () => {
      const r = await post({ method: 'tools/list', params: {} }, {
        auto: false, headers: { 'MCP-Protocol-Version': '2030-01-01' },
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error.code, -32022);
      assert.ok(r.body.error.data.supported.includes(MODERN));
    });

    await test('unknown method is HTTP 404 with -32601 in the body', async () => {
      const r = await post({ method: 'resources/read', params: {} });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.body.error.code, -32601);
    });

    await test('a hostile Origin is 403 before anything else runs', async () => {
      const r = await post({ method: 'tools/list', params: {} }, {
        headers: { Origin: 'https://evil.example.com' },
      });
      assert.strictEqual(r.status, 403);
      const local = await post({ method: 'tools/list', params: {} }, {
        headers: { Origin: `http://localhost:${HTTP_PORT}` },
      });
      assert.strictEqual(local.status, 200, 'a local page passes');
    });

    await test('GET and DELETE are 405 — no GET stream, no session DELETE in this revision', async () => {
      for (const method of ['GET', 'DELETE']) {
        const r = await fetch(MCP, { method });
        assert.strictEqual(r.status, 405, `${method} is refused`);
        assert.strictEqual(r.headers.get('allow'), 'POST');
      }
    });

    await test('Mcp-Session-Id from an older client is ignored and never echoed or minted', async () => {
      const r = await post({ method: 'tools/list', params: {} }, {
        headers: { 'Mcp-Session-Id': 'stale-legacy-session', 'Last-Event-ID': '42' },
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('mcp-session-id'), null);
      assert.strictEqual(r.body.result.tools.length, 7);
    });

    await test('a notification is 202 with an empty body', async () => {
      const r = await post({ id: null, method: 'notifications/whatever', params: {} }, { auto: false });
      assert.strictEqual(r.status, 202);
      assert.strictEqual(r.raw, '');
    });

    await test('legacy era over HTTP: initialize → version-less tools/call, served in legacy shape', async () => {
      const init = await post({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }, { auto: false });
      assert.strictEqual(init.status, 200);
      assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
      const call = await post({ method: 'tools/call', params: { name: 'status', arguments: {} } }, { auto: false });
      assert.strictEqual(call.status, 200);
      assert.strictEqual(call.body.result.resultType, undefined, 'legacy shape — no modern fields');
      const stats = JSON.parse(call.body.result.content[0].text);
      assert.strictEqual(stats.total_sessions, 1);
    });

    await test('the credential appears in no HTTP response — even one that legitimately selects it', async () => {
      const r = await post({ method: 'tools/call', params: { name: 'sql', arguments: { query: `SELECT '${PASS}' AS x` } } });
      assert.ok(!r.raw.includes(PASS), 'password never crosses the wire');
      assert.ok(r.raw.includes('[redacted]'));
    });

    await test('the dashboard beside the endpoint still answers — one process, no new daemon', async () => {
      const ping = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/ping`)).json();
      assert.strictEqual(ping.app, 'agentlytics');
      assert.strictEqual(ping.pid, server.pid, 'same process serves both');
    });

    await test("the dashboard's own SQL console keeps its guard after the extraction", async () => {
      // /api/query's construct-aware reader moved into memhouse/server/sql-guard.js so
      // the MCP `sql` tool could share it. Nothing about this endpoint's answers may
      // change: reads work, a dial-out is 403, another database is 403, a write shape
      // is 403 — the route keeps its own policy on top of the shared reader.
      const post = async (sql) => {
        const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/query`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
        });
        return { status: res.status, body: await res.json() };
      };
      const ok = await post('SELECT count() AS n FROM messages');
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body).slice(0, 120));
      assert.ok(Number(ok.body.rows[0].n) > 0, 'the console reads the seeded house');

      const dial = await post("SELECT * FROM remote('192.0.2.7:9000', 'system', 'one')");
      assert.strictEqual(dial.status, 403);
      assert.ok(/table function remote\(\) is not allowed here/.test(dial.body.error), dial.body.error);

      const other = await post('SELECT count() FROM system.users');
      assert.strictEqual(other.status, 403);
      assert.ok(/another database/.test(other.body.error), other.body.error);

      const write = await post("INSERT INTO messages (session_id, seq) VALUES ('x', 1)");
      assert.strictEqual(write.status, 403);
      assert.ok(/Only SELECT queries are allowed/.test(write.body.error), write.body.error);

      // The disguises are the reader's whole reason to exist; one on this surface too.
      const hidden = await post("SELECT '--' AS a, * FROM remote('192.0.2.7:9000', 'system', 'one')");
      assert.strictEqual(hidden.status, 403);
    });

  } finally {
    if (server) server.kill();
    sh('docker', ['rm', '-f', '-v', NAME]);
  }

  if (process.exitCode) console.error(`\n${passed} passed, some failed`);
  else console.log(`\n${passed}/${passed} http mcp checks pass (house removed)`);
  process.exit(process.exitCode || 0);
})();
