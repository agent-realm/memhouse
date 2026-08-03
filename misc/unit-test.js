#!/usr/bin/env node
// Unit gate for the pure logic `npm test`'s syntax check cannot reach: room-name
// resolution and env-file quoting. Both are places where a silent wrong answer is worse
// than a crash — a room name that resolves wrong writes into the wrong table, and a
// mis-decoded credential authenticates as nobody.
//
// Two cases here exist specifically to keep a defect from coming back:
//   * `viewName` must not produce a name the Merge selector can match. It did, and
//     `all_sessions` double-counted every session (161 -> 322) until the view moved to
//     the `v_` prefix.
//   * `envfile.parse` must decode the `'\''` escape it writes. A parser that only
//     stripped the outer quotes handed the shipper a different password than the
//     interactive commands used, and the only symptom was an auth failure.
//
// No server, no fixtures, no network. Runs in milliseconds.

const assert = require('assert');
const rooms = require('../mem-house/per-member/rooms');
const envfile = require('../mem-house/envfile');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// ── room names ──────────────────────────────────────────────────────────────────
test('shared layout uses the bare names', () => {
  const r = rooms.roomNames(null);
  assert.strictEqual(r.sessions, 'sessions');
  assert.strictEqual(r.messages, 'messages');
  assert.strictEqual(r.tool_calls, 'tool_calls');
  assert.strictEqual(r.sessions_v, 'sessions_v');
  assert.strictEqual(r.perMember, false);
});

test('per-member layout suffixes rooms with the member', () => {
  const r = rooms.roomNames('alice');
  assert.strictEqual(r.sessions, 'sessions_alice');
  assert.strictEqual(r.messages, 'messages_alice');
  assert.strictEqual(r.tool_calls, 'tool_calls_alice');
  assert.strictEqual(r.perMember, true);
  assert.strictEqual(r.member, 'alice');
});

test('the view is PREFIXED, so the Merge selector cannot match it', () => {
  const r = rooms.roomNames('alice');
  assert.strictEqual(r.sessions_v, 'v_sessions_alice');
  // The three selectors from schema-merge.sql.tpl, verbatim.
  for (const re of [/^sessions_/, /^messages_/, /^tool_calls_/]) {
    assert.ok(!re.test(r.sessions_v), `${re} must not match ${r.sessions_v}`);
  }
  // ...and still matches the room it is supposed to.
  assert.ok(/^sessions_/.test(r.sessions));
});

test('the v_ prefix is reserved, so no handle can recreate the collision', () => {
  assert.throws(() => rooms.roomNames('v_bob'), /reserved/);
  assert.throws(() => rooms.assertUsableMember('v_'), /reserved/);
  assert.doesNotThrow(() => rooms.roomNames('victor')); // 'v' alone is fine
});

test('handles that would need quoting are refused', () => {
  for (const bad of ['1alice', 'ali ce', 'ali-ce', "ali'ce", 'ali.ce', '']) {
    assert.throws(() => rooms.assertUsableMember(bad), /expected|reserved/, `accepted '${bad}'`);
  }
});

test('perMemberEnabled reads exactly MEM_PER_MEMBER=1', () => {
  const saved = process.env.MEM_PER_MEMBER;
  try {
    for (const [v, want] of [['1', true], ['0', false], ['true', false], [undefined, false]]) {
      if (v === undefined) delete process.env.MEM_PER_MEMBER; else process.env.MEM_PER_MEMBER = v;
      assert.strictEqual(rooms.perMemberEnabled(), want, `MEM_PER_MEMBER=${v}`);
    }
  } finally {
    if (saved === undefined) delete process.env.MEM_PER_MEMBER; else process.env.MEM_PER_MEMBER = saved;
  }
});

// ── env file ────────────────────────────────────────────────────────────────────
test('shell quoting round-trips, including quotes and backslashes', () => {
  for (const v of ["ab'cd", 'ab\\ef', "ab'cd\\ef", 'plain', 'a b c', '$(rm -rf /)', '']) {
    const line = `MEMHOUSE_PASSWORD=${envfile.quoteShell(v)}`;
    assert.strictEqual(envfile.parse(line).MEMHOUSE_PASSWORD, v, `round-trip failed for ${JSON.stringify(v)}`);
  }
});

test('a parser that only strips outer quotes would be wrong', () => {
  // The regression this guards: the old service.js parser produced ab'\''cd here.
  const line = `MEMHOUSE_PASSWORD=${envfile.quoteShell("ab'cd")}`;
  assert.strictEqual(line, "MEMHOUSE_PASSWORD='ab'\\''cd'");
  assert.strictEqual(envfile.parse(line).MEMHOUSE_PASSWORD, "ab'cd");
});

test('systemd quoting escapes what systemd escapes', () => {
  assert.strictEqual(envfile.quoteSystemd('ab"cd'), '"ab\\"cd"');
  assert.strictEqual(envfile.quoteSystemd('ab\\cd'), '"ab\\\\cd"');
  assert.strictEqual(envfile.quoteSystemd("ab'cd"), '"ab\'cd"'); // a quote needs no escape here
});

test('a value with a newline is refused rather than truncated', () => {
  assert.throws(() => envfile.assertSingleLine({ MEMHOUSE_PASSWORD: 'a\nb' }), /newline/);
  assert.doesNotThrow(() => envfile.assertSingleLine({ MEMHOUSE_PASSWORD: 'ab' }));
});

test('comments and blank lines are ignored', () => {
  const parsed = envfile.parse("# a comment\n\nMEMHOUSE_DB='mem'\n#MEMHOUSE_DB='nope'\n");
  assert.strictEqual(parsed.MEMHOUSE_DB, 'mem');
  assert.strictEqual(Object.keys(parsed).length, 1);
});

if (process.exitCode) console.error(`\n${passed} passed, some failed`);
else console.log(`${passed}/${passed} unit checks pass`);
