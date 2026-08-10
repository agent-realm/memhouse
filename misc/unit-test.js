#!/usr/bin/env node
// Unit gate for the pure logic `npm test`'s syntax check cannot reach: room-name
// resolution and env-file quoting. Both are places where a silent wrong answer is worse
// than a crash — a room name that resolves wrong writes into the wrong table, and a
// mis-decoded credential authenticates as nobody.
//
// Two cases here exist specifically to keep a defect from coming back:
//   * a Merge selector must not match the Merge room it defines. One did, and
//     `all_sessions` double-counted every session (161 -> 322).
//   * `envfile.parse` must decode the `'\''` escape it writes. A parser that only
//     stripped the outer quotes handed the shipper a different password than the
//     interactive commands used, and the only symptom was an auth failure.
//
// No server, no fixtures, no network. Runs in milliseconds.

const assert = require('assert');
const rooms = require('../memhouse/per-member/rooms');
const envfile = require('../memhouse/envfile');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// ── room names ──────────────────────────────────────────────────────────────────
test('rooms are suffixed with the member', () => {
  const r = rooms.roomNames('alice');
  assert.strictEqual(r.sessions, 'sessions_alice');
  assert.strictEqual(r.messages, 'messages_alice');
  assert.strictEqual(r.tool_calls, 'tool_calls_alice');
  assert.strictEqual(r.member, 'alice');
});

test('there is no shared layout to fall back to', () => {
  // roomNames used to accept null for three bare rooms. A caller that still passes null
  // must fail loudly rather than silently addressing rooms nobody writes.
  for (const bad of [null, undefined]) assert.throws(() => rooms.roomNames(bad), /expected/);
});

test('the session rollup is a QUERY, not a fourth object', () => {
  const alice = rooms.roomNames('alice');
  // SQL text, substituted into the same `FROM ... AS c` position a view name would hold.
  assert.ok(alice.sessions_v.startsWith('('), 'the rollup must be a subquery');
  assert.ok(alice.sessions_v.includes('FROM sessions_alice AS s'), alice.sessions_v);
  assert.ok(alice.sessions_v.includes('LEFT JOIN messages_alice AS m'), 'the LEFT JOIN must survive');
  // No name means nothing for the Merge selectors to swallow — the whole class of
  // collision a `sessions_v_alice` view created does not exist.
  for (const re of [/^sessions_/, /^messages_/, /^tool_calls_/]) {
    assert.ok(!re.test(alice.sessions_v), `${re} must not match a subquery`);
  }
});

test('the rollup is self-contained — it needs nothing from the caller', () => {
  // This test used to assert the OPPOSITE, on the belief that a subquery cannot carry a
  // trailing SETTINGS clause. It can (verified on 26.7.2.59 and 25.11.9.34), and the
  // belief cost real accuracy: any consumer that forgot final=1 counted every message
  // once per undeleted ReplacingMergeTree version — 2x right after a ship, 3x a few ships
  // later, growing until a merge happened to collapse the parts.
  const v = rooms.roomNames('alice').sessions_v;
  assert.match(v, /SETTINGS join_use_nulls = 1/, 'rollup must carry join_use_nulls itself');
  // Alias BEFORE final: `FROM t FINAL AS s` is a syntax error, `FROM t AS s FINAL` is not.
  assert.match(v, /FROM sessions_alice AS s FINAL/, 'sessions must be read FINAL');
  assert.match(v, /LEFT JOIN messages_alice AS m FINAL/, 'messages must be read FINAL');
  // READ_SETTINGS still applies to DIRECT room reads, which carry no FINAL of their own.
  assert.strictEqual(rooms.READ_SETTINGS.join_use_nulls, 1);
  assert.strictEqual(rooms.READ_SETTINGS.final, 1);
});

test("'root' is refused at the rooms layer, in any case", () => {
  // provision.js is an admin entry point in its own right; a reservation that lives only
  // in the CLI let `provision.js --member root` create three orphan rooms before failing.
  for (const r of ['root', 'Root', 'ROOT', 'rOOt']) {
    assert.throws(() => rooms.assertUsableMember(r), /container artefact/, `accepted '${r}'`);
  }
  // 'default' is a poor member name but a real one; existing houses use it.
  assert.doesNotThrow(() => rooms.assertUsableMember('default'));
});

test('handles that would need quoting are refused', () => {
  for (const bad of ['1alice', 'ali ce', 'ali-ce', "ali'ce", 'ali.ce', '']) {
    assert.throws(() => rooms.assertUsableMember(bad), /expected/, `accepted '${bad}'`);
  }
});

test('every Merge selector matches member rooms and never itself', () => {
  // Read the patterns out of the template rather than restating them, so a change there
  // has to face this test.
  //
  // Self-match is the property that matters now that there is one layout: `^sessions_`
  // must catch `sessions_<anyone>` and must NOT catch `all_sessions`, or the Merge room
  // reads itself. Type-first naming is what buys this — `<member>_sessions` could not.
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'per-member', 'schema-merge.sql.tpl'), 'utf-8');
  const pats = [...tpl.matchAll(/Merge\(currentDatabase\(\), '([^']+)'\)/g)].map((m) => m[1]);
  assert.strictEqual(pats.length, rooms.ROOM_TYPES.length, 'one Merge room per room type');
  const all = Object.values(rooms.mergeRooms());
  for (const [i, t] of rooms.ROOM_TYPES.entries()) {
    const sel = new RegExp(pats[i]);
    assert.ok(sel.test(`${t}_alice`), `${pats[i]} must match ${t}_alice`);
    assert.ok(sel.test(`${t}_v`), `${pats[i]} must match ${t}_v — 'v' is an ordinary handle now`);
    for (const room of all) assert.ok(!sel.test(room), `${pats[i]} must not match the Merge room ${room}`);
  }
});

test('the shipper clear must bind origin, or it deletes imported history', () => {
  // Regression, and an expensive one. The clear exists so a shorter re-parse cannot leave
  // a stale seq tail; scoped to (session_id, user_id) alone it removed EVERY row for the
  // session, including imported rows the adapters cannot reproduce. On a real house that
  // cost 27,948 of 135,307 messages in a single ship pass.
  //
  // Asserted against the source text because the delete is one line inside a loop with no
  // seam to call — and a seam invented purely for a test is a worse guarantee than reading
  // the statement that actually runs.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'shipper', 'ship.js'), 'utf-8');
  const del = src.match(/DELETE FROM \$\{rooms\[t\]\}[^`]*/);
  assert.ok(del, 'the per-session clear was not found in ship.js');
  assert.ok(/session_id = \{id:String\}/.test(del[0]), 'clear must bind the session');
  assert.ok(/user_id = \{uid:String\}/.test(del[0]), 'clear must bind the user');
  assert.ok(/origin = 'ship'/.test(del[0]),
    "clear must bind origin='ship' — without it, re-shipping a session destroys imported rows");
});

test('every room type carries an origin column defaulting to ship', () => {
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'per-member', 'schema-member.sql.tpl'), 'utf-8');
  const n = (tpl.match(/origin LowCardinality\(String\) DEFAULT 'ship'/g) || []).length;
  assert.strictEqual(n, rooms.ROOM_TYPES.length,
    `origin must be on all ${rooms.ROOM_TYPES.length} room types, found ${n}`);
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
const service = require('../memhouse/service');
const os = require('os');

const SVC = {
  node: '/usr/bin/node',
  script: '/opt/memhouse/ship.js',
  args: ['--loop', '300'],
  env: { MEMHOUSE_URL: 'http://h:8123', MEMHOUSE_PASSWORD: "ab'cd\\ef", MEMHOUSE_DB: 'mem' },
  logDir: '/var/log/memhouse',
  logName: 'shipper.log',
};

test('systemd unit inlines env with systemd quoting, not shell quoting', () => {
  const unit = service._render.systemdUnit({ ...SVC, description: 'd' });
  assert.ok(unit.includes('Environment=MEMHOUSE_PASSWORD="ab\'cd\\\\ef"'), unit);
  assert.ok(unit.includes('Environment=MEMHOUSE_DB="mem"'), 'the house must travel with the unit');
  assert.ok(!unit.includes('EnvironmentFile'), 'the shell-quoted file must not be read by systemd');
  assert.ok(unit.includes('ExecStart=/usr/bin/node /opt/memhouse/ship.js --loop 300'));
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
  const deploy = require('../memhouse/deploy');
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

test('an engine that cannot answer is never dropped from ownership', () => {
  const deploy = require('../memhouse/deploy');
  // The pin is the escape hatch, and it must win outright — this is the only way off
  // the indeterminate path when a second engine's daemon is down.
  const saved = process.env.MEMHOUSE_ENGINE;
  try {
    process.env.MEMHOUSE_ENGINE = 'podman';
    const o = deploy.owningEngine();
    assert.strictEqual(o.engine, 'podman');
    assert.strictEqual(o.pinned, true);
    assert.strictEqual(o.indeterminate, undefined);
  } finally {
    if (saved === undefined) delete process.env.MEMHOUSE_ENGINE; else process.env.MEMHOUSE_ENGINE = saved;
  }
});

if (process.exitCode) console.error(`\n${passed} passed, some failed`);
else console.log(`${passed}/${passed} unit checks pass`);
