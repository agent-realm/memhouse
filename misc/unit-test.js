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
const rooms = require('../memhouse/house/house');
const envfile = require('../memhouse/envfile');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// ── the house's rooms ───────────────────────────────────────────────────────────
test('rooms are plain shared tables — the database is the boundary', () => {
  const r = rooms.roomNames('alice');
  assert.strictEqual(r.sessions, 'sessions');
  assert.strictEqual(r.messages, 'messages');
  assert.strictEqual(r.tool_calls, 'tool_calls');
  // The identity still travels with the names: writers BIND it (ship.js's clear), and
  // readers scope by it. Losing it here silently un-scopes every consumer.
  assert.strictEqual(r.member, 'alice');
  assert.strictEqual(r.user, 'alice');
});

test('the session rollup is a QUERY, not a fourth object', () => {
  const r = rooms.roomNames('alice');
  // SQL text, substituted into the same `FROM ... AS c` position a view name would hold.
  assert.ok(r.sessions_v.startsWith('('), 'the rollup must be a subquery');
  assert.ok(r.sessions_v.includes('FROM sessions AS s'), r.sessions_v);
  assert.ok(r.sessions_v.includes('LEFT JOIN messages AS m'), 'the LEFT JOIN must survive');
  // Shared tables make this the load-bearing line: two housemates' rows must never merge,
  // even on a colliding session_id.
  assert.match(r.sessions_v, /GROUP BY s\.session_id, s\.user_id/, 'rollup must group by user too');
});

test('the rollup is self-contained — it needs nothing from the caller', () => {
  // This test used to assert the OPPOSITE, on the belief that a subquery cannot carry a
  // trailing SETTINGS clause. It can (verified on 26.7.2.59 and 25.11.9.34), and the
  // belief cost real accuracy: any consumer that forgot final=1 counted every message
  // once per undeleted ReplacingMergeTree version — 2x right after a ship, growing until
  // a merge happened to collapse the parts.
  const v = rooms.roomNames('alice').sessions_v;
  assert.match(v, /SETTINGS join_use_nulls = 1/, 'rollup must carry join_use_nulls itself');
  // Alias BEFORE final: `FROM t FINAL AS s` is a syntax error, `FROM t AS s FINAL` is not.
  assert.match(v, /FROM sessions AS s FINAL/, 'sessions must be read FINAL');
  assert.match(v, /LEFT JOIN messages AS m FINAL/, 'messages must be read FINAL');
  // READ_SETTINGS still applies to DIRECT room reads, which carry no FINAL of their own.
  assert.strictEqual(rooms.READ_SETTINGS.join_use_nulls, 1);
  assert.strictEqual(rooms.READ_SETTINGS.final, 1);
});

test('names that would need quoting, and ClickHouse-owned databases, are refused', () => {
  for (const bad of ['1alice', 'ali ce', 'ali-ce', "ali'ce", 'ali.ce', '']) {
    assert.throws(() => rooms.assertUsableName(bad), /expected/, `accepted '${bad}'`);
  }
  for (const owned of ['system', 'SYSTEM', 'information_schema']) {
    assert.throws(() => rooms.assertUsableName(owned), /ClickHouse's own/, `accepted '${owned}'`);
  }
  // `default` is deliberately allowed — a stock container's default database is a real
  // place to keep a house, and user 'alice' with house 'default' is a supported pairing.
  assert.doesNotThrow(() => rooms.assertUsableName('default'));
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
    require('path').join(__dirname, '..', 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
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

// ── resume ──────────────────────────────────────────────────────────────────────
// The point of this command is that a wrong answer is impossible, so these check the
// refusals rather than the happy path.
test('a resumable session becomes a pasteable command, cd included', () => {
  const { resumeFor } = require('../memhouse/resume');
  const r = resumeFor({ session_id: 'claude-code:6b1f-abc', source: 'claude-code', folder: '/tmp/proj' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.command, 'cd /tmp/proj && claude --resume 6b1f-abc');
});

test('the table is keyed on the STORED source, not the adapter module name', () => {
  // editors/claude.js is `const name = 'claude'` and emits `source: 'claude-code'`. Keyed on
  // the module name this refused every Claude Code session in the house — 508 of them.
  const { RESUMERS } = require('../memhouse/resume');
  assert.ok(RESUMERS['claude-code'], 'claude-code is what lands in the source column');
  assert.ok(!RESUMERS.claude, 'claude is the module name and never appears in a row');
});

test('an imported session is refused before its source is even consulted', () => {
  // 502 of 1,304 sessions in the house this was built against are imported claude-ai rows:
  // no local store behind them, so no resume command can be right.
  const { resumeFor } = require('../memhouse/resume');
  const r = resumeFor({ session_id: 'claude-code:x', source: 'claude-code', folder: '/tmp/p', origin: 'import' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /imported/);
});

test('a session id splits on the FIRST colon', () => {
  // Several editors put colons inside their own ids. Splitting on the last one hands the
  // CLI a truncated id, which resolves to nothing — or to a different session.
  const { resumeFor } = require('../memhouse/resume');
  const r = resumeFor({ session_id: 'codex:2026-08-12T10:30:00Z', source: 'codex', folder: '' });
  assert.strictEqual(r.nativeId, '2026-08-12T10:30:00Z');
  assert.strictEqual(r.command, 'codex resume 2026-08-12T10:30:00Z');
});

test('a folder with a space still pastes correctly', () => {
  const { resumeFor } = require('../memhouse/resume');
  const r = resumeFor({ session_id: 'claude-code:x', source: 'claude-code', folder: '/tmp/my proj' });
  assert.strictEqual(r.command, "cd '/tmp/my proj' && claude --resume x");
});

test('a GUI editor refuses, and says which kind of refusal it is', () => {
  const { resumeFor } = require('../memhouse/resume');
  const r = resumeFor({ session_id: 'zed:99', source: 'zed', folder: '/tmp/p' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.command, null);
  assert.match(r.reason, /GUI editor/);
  assert.strictEqual(r.folder, '/tmp/p'); // still the one actionable fact we hold
});

test('every source an adapter can emit lands in exactly one bucket', () => {
  // The guard for a class that has now bitten twice in this one file: a source string
  // matching no bucket falls through to "no verified resume command", which reads as "not
  // checked yet" even when the truth is "there is no CLI at all".
  //
  // The inventory is DERIVED from the adapters, never restated here — restating by hand is
  // exactly how 'windsurf' came to be listed when what it emits is devin/devin-next, and how
  // the table was first keyed on 'claude' when the rows carry 'claude-code'.
  const { RESUMERS, GUI_ONLY, UNVERIFIED } = require('../memhouse/resume');
  const fs2 = require('fs'), path2 = require('path');
  const dir = path2.join(__dirname, '..', 'editors');
  const sources = new Set();
  for (const f of fs2.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs2.readFileSync(path2.join(dir, f), 'utf-8');
    for (const m of src.matchAll(/source: *'([a-z0-9-]+)'/g)) sources.add(m[1]);
    // windsurf builds `source` from its VARIANTS ids rather than from a literal.
    if (f === 'windsurf.js') for (const m of src.matchAll(/^\s+id: '([a-z0-9-]+)',/gm)) sources.add(m[1]);
  }
  assert.ok(sources.size >= 15, `expected the adapter inventory, got ${sources.size}`);
  for (const s of sources) {
    const buckets = [
      RESUMERS[s] ? 'resumable' : null,
      GUI_ONLY.has(s) ? 'gui' : null,
      UNVERIFIED.has(s) ? 'unverified' : null,
    ].filter(Boolean);
    assert.strictEqual(buckets.length, 1, `source '${s}' is in ${buckets.length} buckets (${buckets.join(', ') || 'none'})`);
  }
});

test('an unverified CLI is refused, never guessed', () => {
  // goose is plausibly resumable and deliberately absent: its flag was never read from its
  // own --help. A guessed entry prints a command that silently does the wrong thing.
  const { resumeFor, RESUMERS } = require('../memhouse/resume');
  assert.ok(!RESUMERS.goose, 'goose stays out until its flag is READ, not recalled');
  const r = resumeFor({ session_id: 'goose:1', source: 'goose', folder: '' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no verified resume command/);
});

// ── self-update ─────────────────────────────────────────────────────────────────
const selfUpdate = require('../memhouse/self-update');
const fsx = require('fs');
const pathx = require('path');

// A throwaway installation: package.json at the root, an entry two levels down, exactly
// the shape both daemons have.
function fakeInstall(version) {
  const root = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'mh-selfupd-'));
  fsx.mkdirSync(pathx.join(root, 'sub'), { recursive: true });
  const entry = pathx.join(root, 'sub', 'entry.js');
  fsx.writeFileSync(entry, '// daemon\n');
  fsx.writeFileSync(pathx.join(root, 'package.json'), JSON.stringify({ version }));
  return { root, entry };
}

test('drift is read off disk, not from a cached require', () => {
  const { root, entry } = fakeInstall('1.0.0');
  try {
    const snap = selfUpdate.snapshot(entry, root);
    assert.strictEqual(selfUpdate.driftReason(snap), null);
    // require() would have cached 1.0.0 for the life of the process — which is precisely
    // the value being watched for change, and precisely why fs is used instead.
    fsx.writeFileSync(pathx.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }));
    assert.match(selfUpdate.driftReason(snap), /1\.0\.0 → 1\.0\.1/);
  } finally { fsx.rmSync(root, { recursive: true, force: true }); }
});

test('a vanished entry is drift, and is reported rather than exec-ed', () => {
  const { root, entry } = fakeInstall('1.0.0');
  try {
    const snap = selfUpdate.snapshot(entry, root);
    fsx.rmSync(entry);
    assert.match(selfUpdate.driftReason(snap), /no longer exists/);
    // maybeRestart RETURNING (rather than exiting this process) is the assertion: inside
    // the 60s floor nothing may happen at all, which is the guard against a boot loop.
    assert.strictEqual(selfUpdate.maybeRestart({ snap, name: 'shipper', log: () => {} }), false);
  } finally { fsx.rmSync(root, { recursive: true, force: true }); }
});

test('a re-exec chain that has hit its cap does not restart again', () => {
  const { root, entry } = fakeInstall('1.0.0');
  const saved = process.env[selfUpdate.CHAIN_VAR];
  try {
    const snap = selfUpdate.snapshot(entry, root);
    snap.at = Date.now() - selfUpdate.MIN_INTERVAL_MS - 1; // past the floor
    fsx.writeFileSync(pathx.join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    process.env[selfUpdate.CHAIN_VAR] = String(selfUpdate.MAX_CHAIN);
    // Without the cap this would spawn and exit(0), taking the test run with it.
    assert.strictEqual(selfUpdate.maybeRestart({ snap, name: 'shipper', log: () => {} }), false);
  } finally {
    if (saved === undefined) delete process.env[selfUpdate.CHAIN_VAR]; else process.env[selfUpdate.CHAIN_VAR] = saved;
    fsx.rmSync(root, { recursive: true, force: true });
  }
});

// ── claude config discovery ─────────────────────────────────────────────────────
// The plugin installer reuses the ADAPTER's root discovery rather than carrying its own —
// two implementations of "find every CLAUDE_CONFIG_DIR" would drift the first time a
// playbook layout changes, which is exactly the defect install.sh was retired for.
test('the adapter exports the root discovery the CLI installs into', () => {
  const claude = require('../editors/claude');
  assert.strictEqual(typeof claude.discoverClaudeRoots, 'function',
    'bin/memhouse.js requires this export; without it the installer silently sees no playbooks');
});

test('playbook config dirs are discovered, used ones only', () => {
  const claude = require('../editors/claude');
  const home = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'mh-claude-home-'));
  const saved = process.env.HOME;
  try {
    // A used root (has projects/), a used legacy-layout root, and an unused one that must
    // NOT be offered — installing skills into a directory nobody runs is noise.
    fsx.mkdirSync(pathx.join(home, '.claude-playbooks', 'alpha', 'projects'), { recursive: true });
    fsx.mkdirSync(pathx.join(home, '.claude-playbooks', 'beta', 'playbook', 'projects'), { recursive: true });
    fsx.mkdirSync(pathx.join(home, '.claude-playbooks', 'unused'), { recursive: true });
    process.env.HOME = home;
    // os.homedir() reads HOME on first call and the adapter caches it at require time, so
    // this asserts on the pure function with the module reloaded under the new HOME.
    delete require.cache[require.resolve('../editors/claude')];
    const roots = require('../editors/claude').discoverClaudeRoots().map((r) => r.replace(home, ''));
    assert.ok(roots.some((r) => r.endsWith('/alpha')), `alpha missing from ${roots}`);
    assert.ok(roots.some((r) => r.endsWith('/beta/playbook')), `legacy beta/playbook missing from ${roots}`);
    assert.ok(!roots.some((r) => r.endsWith('/unused')), `an unused dir was offered: ${roots}`);
  } finally {
    process.env.HOME = saved;
    delete require.cache[require.resolve('../editors/claude')];
    fsx.rmSync(home, { recursive: true, force: true });
  }
});

// ── host identity ───────────────────────────────────────────────────────────────
// `host` is the only column separating one member's machines from each other, since all
// of them write into the same rooms. These are about the two ways the old derived id
// (sha256 of hostname|platform|arch) got that wrong.
const hostjs = require('../memhouse/host');

function tmpHome() { return fsx.mkdtempSync(pathx.join(os.tmpdir(), 'mh-host-')); }

test('the identity is written once and then never moves', () => {
  const home = tmpHome();
  try {
    const a = hostjs.identity(home);
    const b = hostjs.identity(home);
    assert.strictEqual(a.id, b.id, 'a second call must not mint a new identity');
    assert.match(a.id, /^[A-Za-z0-9_-]+-[0-9a-f]{8}$/, `unexpected id shape: ${a.id}`);
    assert.ok(fsx.existsSync(hostjs.filePath(home)), 'the fingerprint must be persisted');
    // 0600: not a secret, but anything that can read it can write rows as this host.
    assert.strictEqual(fsx.statSync(hostjs.filePath(home)).mode & 0o777, 0o600);
  } finally { fsx.rmSync(home, { recursive: true, force: true }); }
});

test('two machines that look identical still get different ids', () => {
  // THE bug in the derived scheme: two laptops with the same default hostname on the same
  // platform and arch hashed to one id, so their sessions merged into a single apparent
  // host and neither could be told from the other.
  const a = tmpHome(), b = tmpHome();
  try {
    assert.notStrictEqual(hostjs.identity(a).id, hostjs.identity(b).id,
      'identical machines must not collide — the fingerprint is random, not derived');
  } finally { for (const h of [a, b]) fsx.rmSync(h, { recursive: true, force: true }); }
});

test('renaming the machine does not split its history', () => {
  // The other direction: a derived id moved when the hostname changed, so the machine's
  // own rows appeared to stop and a stranger's to start. The id is frozen at creation and
  // the new name is reported separately.
  const home = tmpHome();
  try {
    const first = hostjs.identity(home);
    const rec = JSON.parse(fsx.readFileSync(hostjs.filePath(home), 'utf-8'));
    rec.hostname = 'some-old-name';       // as if the machine had been renamed since
    fsx.writeFileSync(hostjs.filePath(home), JSON.stringify(rec));
    const after = hostjs.identity(home);
    assert.strictEqual(after.id, first.id, 'the id must survive a rename');
    assert.strictEqual(after.hostname, 'some-old-name', 'the name it was created under is kept');
    assert.strictEqual(after.renamed, true, 'a rename must be visible to callers');
    assert.strictEqual(after.current_hostname, os.hostname());
  } finally { fsx.rmSync(home, { recursive: true, force: true }); }
});

test('a corrupt fingerprint file is replaced, not obeyed', () => {
  // An unreadable identity must not become a crash in the shipper's hot path, and must
  // not silently produce a different id on every pass either.
  const home = tmpHome();
  try {
    fsx.mkdirSync(home, { recursive: true });
    fsx.writeFileSync(hostjs.filePath(home), '{ not json');
    const a = hostjs.identity(home);
    assert.match(a.id, /-[0-9a-f]{8}$/);
    assert.strictEqual(a.id, hostjs.identity(home).id, 'the replacement must then be stable');
  } finally { fsx.rmSync(home, { recursive: true, force: true }); }
});

if (process.exitCode) console.error(`\n${passed} passed, some failed`);
else console.log(`${passed}/${passed} unit checks pass`);
