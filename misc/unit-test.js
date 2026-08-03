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

// ── service files ───────────────────────────────────────────────────────────────
// Rendered, not installed. On macOS the plist is additionally linted with plutil, which
// is the only check available for a file we must not load on this machine.
const service = require('../mem-house/service');
const os = require('os');

const SVC = {
  node: '/usr/bin/node',
  script: '/opt/memhouse/ship.js',
  args: ['--loop', '300'],
  env: { MEMHOUSE_URL: 'http://h:8123', MEMHOUSE_PASSWORD: "ab'cd\\ef", MEM_PER_MEMBER: '1' },
  logDir: '/var/log/memhouse',
  logName: 'shipper.log',
};

test('systemd unit inlines env with systemd quoting, not shell quoting', () => {
  const unit = service._render.systemdUnit({ ...SVC, description: 'd' });
  assert.ok(unit.includes('Environment=MEMHOUSE_PASSWORD="ab\'cd\\\\ef"'), unit);
  assert.ok(unit.includes('Environment=MEM_PER_MEMBER="1"'), 'layout switch must travel with the unit');
  assert.ok(!unit.includes('EnvironmentFile'), 'the shell-quoted file must not be read by systemd');
  assert.ok(unit.includes('ExecStart=/usr/bin/node /opt/memhouse/ship.js --loop 300'));
});

test('systemd ordering is emitted only when the solo unit is wanted', () => {
  const plain = service._render.systemdUnit({ ...SVC, description: 'd' });
  assert.ok(!plain.includes('memhouse-solo.service'));
  const ordered = service._render.systemdUnit({ ...SVC, description: 'd', after: ['memhouse-solo.service'] });
  assert.ok(ordered.includes('After=memhouse-solo.service'));
  assert.ok(ordered.includes('Wants=memhouse-solo.service'));
});

test('launchd plist is well-formed and escapes XML metacharacters', () => {
  const plist = service._render.launchdPlist({
    ...SVC, label: 'com.memhouse.shipper',
    env: { ...SVC.env, TRICKY: 'a & b < c > d' },
  });
  assert.ok(plist.startsWith('<?xml'), 'missing XML declaration');
  assert.ok(plist.includes('<string>a &amp; b &lt; c &gt; d</string>'), 'XML metacharacters not escaped');
  // The credential travels decoded — the shell escape must NOT survive into the plist.
  assert.ok(plist.includes("<string>ab'cd\\ef</string>"), plist);
  assert.ok(!plist.includes("'\\''"), 'shell quoting leaked into the plist');
  // Every opened tag closes.
  for (const tag of ['plist', 'dict', 'array']) {
    const open = (plist.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (plist.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.strictEqual(open, close, `<${tag}> unbalanced`);
  }
  // On macOS, let the platform's own parser be the judge.
  if (process.platform === 'darwin') {
    const fs2 = require('fs');
    const p = require('path').join(os.tmpdir(), `memhouse-plist-check-${process.pid}.plist`);
    fs2.writeFileSync(p, plist);
    try {
      require('child_process').execFileSync('plutil', ['-lint', p], { stdio: 'pipe' });
    } finally { fs2.unlinkSync(p); }
  }
});

test('ExecStart quotes paths containing spaces', () => {
  const unit = service._render.systemdUnit({
    node: '/tmp/a b/node', script: '/opt/mem house/ship.js', args: ['--loop', '300'],
    env: {}, logDir: '/tmp', logName: 'l.log', description: 'd',
  });
  // systemd splits on whitespace; unquoted, the executable would resolve to `/tmp/a`.
  assert.ok(unit.includes('ExecStart="/tmp/a b/node" "/opt/mem house/ship.js" --loop 300'), unit);
  // Plain tokens stay unquoted, so the common case reads normally.
  const plain = service._render.systemdUnit({
    node: '/usr/bin/node', script: '/opt/ship.js', args: ['--loop', '300'],
    env: {}, logDir: '/tmp', logName: 'l.log', description: 'd',
  });
  assert.ok(plain.includes('ExecStart=/usr/bin/node /opt/ship.js --loop 300'), plain);
});

// ── container-engine message classification ────────────────────────────────────
// The regex that decides "this object does not exist" versus "the engine could not
// answer". Getting it wrong in the permissive direction made an unreachable daemon read
// as a clean slate, and `deploy --down` reported success having removed nothing.
test('only object-not-found messages mean absent', () => {
  const deploy = require('../mem-house/deploy');
  const cases = [
    ['Cannot connect to Podman. stat /run/user/1000/podman/podman.sock: no such file or directory', false],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', false],
    ['Error: unable to connect: dial tcp: lookup docker: no such host', false],
    ['Error: No such object: memhouse-clickhouse', true],
    ['Error response from daemon: No such container: memhouse-clickhouse', true],
    ['Error: no such container memhouse-clickhouse', true],
    ['Error: no such volume memhouse-data', true],
  ];
  for (const [msg, want] of cases) {
    assert.strictEqual(deploy._NOT_FOUND.test(msg), want, `misclassified: ${msg}`);
  }
});

if (process.exitCode) console.error(`\n${passed} passed, some failed`);
else console.log(`${passed}/${passed} unit checks pass`);
