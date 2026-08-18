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

test('tools/list (modern): six tools, CacheableResult, and an order that never moves', async () => {
  const a = await handle(req('tools/list', { _meta: modernMeta }), newState());
  const b = await handle(req('tools/list', { _meta: modernMeta }), newState());
  const names = a.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names, ['search', 'timeline', 'get_session', 'stats', 'resume_command', 'sql']);
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
  assert.strictEqual(list.result.tools.length, 6);
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
  const r = await handle(req('tools/call', { name: 'stats', _meta: modernMeta }), newState());
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
  assert.strictEqual(r.result.tools.length, 6);
});

test('string ids round-trip untouched', async () => {
  const r = await handle(req('server/discover', { _meta: modernMeta }, 'discover-1'), newState());
  assert.strictEqual(r.id, 'discover-1');
});

test('a request with params missing entirely is still answered', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, newState());
  assert.strictEqual(r.result.tools.length, 6);
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
  assert.strictEqual(list.result.tools.length, 6);
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
