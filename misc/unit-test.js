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
const { consumeSecretChunk } = require('../memhouse/secret-input');
const { capabilitiesFrom, parseGrantLine } = require('../memhouse/capabilities');
const flagspec = require('../memhouse/flags');
const fs = require('fs');
const path = require('path');

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
  assert.strictEqual(r.sessions_raw, 'sessions');
  assert.strictEqual(r.messages_raw, 'messages');
  assert.strictEqual(r.tool_calls_raw, 'tool_calls');
  // The identity still travels with the names: writers BIND it (the shipper's inserts and
  // its epoch bookkeeping), and readers scope by it. Losing it here silently un-scopes
  // every consumer.
  assert.strictEqual(r.member, 'alice');
  assert.strictEqual(r.user, 'alice');
});

test('the transcript rooms read as the CURRENT parse, and only the raw name is the table', () => {
  // The safety property of the whole epoch design, and it is a property of THIS function:
  // a read path that names a room the ordinary way gets the filtered form whether or not
  // its author knew epochs exist. Only `_raw` reaches the physical table, and an INSERT
  // into a subquery fails loudly — so the danger is moved off the read side, where a
  // mistake silently over-counts, onto the write side, where it cannot be missed.
  const r = rooms.roomNames('alice');
  for (const t of ['messages', 'tool_calls']) {
    assert.ok(r[t].startsWith('('), `${t} must resolve to a subquery, got '${r[t]}'`);
    assert.match(r[t], /max\(epoch\)/, `${t} must restrict to the newest epoch`);
    assert.match(r[t], /origin != 'ship'/,
      `${t} must leave non-shipped rows alone — an import sits at epoch 0 forever, and`
      + ' filtering it against the shipper\'s epoch would hide the whole import');
    assert.match(r[t], /GROUP BY session_id, user_id/,
      `${t} must take the epoch PER SESSION AND USER — a house-wide max would blank every`
      + ' session that had not been compacted');
  }
  // user_id is MATERIALIZED, so `SELECT *` drops it and every consumer that scopes by it
  // breaks. text_ngram/text_word are what `memhouse search` matches on.
  assert.match(r.messages, /SELECT \*, user_id, text_ngram, text_word/);
  assert.match(r.tool_calls, /SELECT \*, user_id/);
  // sessions is one metadata row per session by construction; there is nothing to filter,
  // and its epoch column is for people only.
  assert.strictEqual(r.sessions, 'sessions');
});

test('the session rollup is a QUERY, not a fourth object', () => {
  const r = rooms.roomNames('alice');
  // SQL text, substituted into the same `FROM ... AS c` position a view name would hold.
  assert.ok(r.sessions_v.startsWith('('), 'the rollup must be a subquery');
  assert.ok(r.sessions_v.includes('FROM sessions AS s'), r.sessions_v);
  assert.ok(r.sessions_v.includes('AS m ON m.session_id'), 'the LEFT JOIN must survive');
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
  // The messages side carries its FINAL INSIDE the current-parse subquery instead —
  // `FROM (SELECT …) AS m FINAL` does not parse, and appending FINAL to whatever the room
  // resolved to is exactly the trap the raw/filtered split exists to remove.
  assert.match(v, /LEFT JOIN \(\s*\n\s*SELECT \*/, 'messages must join as the current-parse subquery');
  assert.match(v, /FROM messages FINAL/, 'the current-parse subquery must read FINAL');
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

test('the shipper issues no destructive statement, in any form', () => {
  // This test used to assert that the shipper's per-session DELETE was correctly SCOPED —
  // it had to bind session_id, user_id and origin='ship', because an unscoped version once
  // destroyed 27,948 of 135,307 imported messages in a single pass. The delete is gone
  // instead: a re-parse that cannot be laid over the stored one is written under a new
  // epoch (decideEpoch), so nothing has to be removed to make room for it.
  //
  // Asserted against the source text on purpose. The property is "this file contains no
  // statement that can lose a row", and only reading the file can say that — a seam
  // invented for the test would be a weaker guarantee than the text itself.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'shipper', 'ship.js'), 'utf-8');
  // Comments explain the removed delete at length; strip them before looking for verbs.
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  // Case-sensitive: SQL in this repo is written in caps, and `truncate()` is also the name
  // of the string helper that keeps a lone surrogate out of an insert.
  for (const verb of [/\bDELETE\s+FROM\b/, /\bALTER\s+TABLE\s+\S+\s+DELETE\b/,
    /\bTRUNCATE\s+TABLE\b/, /\bDROP\s+(TABLE|DATABASE|COLUMN)\b/, /\bALTER\s+TABLE\s+\S+\s+UPDATE\b/]) {
    assert.ok(!verb.test(code),
      `ship.js contains ${verb} — the shipper is insert-only, and the grant it documents `
      + 'no longer includes ALTER DELETE');
  }
});

test('a re-parse that only grows reuses its epoch — the common case must stay free', () => {
  const { decideEpoch } = require('../memhouse/shipper/ship');
  const stored = {
    epoch: 0, maxSeq: 1, maxIdx: -1,
    hashes: new Map([[0, '111'], [1, '222']]),
    tools: new Map(),
  };
  const grown = {
    msgRows: [{ seq: 0, line_hash: '111' }, { seq: 1, line_hash: '222' }, { seq: 2, line_hash: '333' }],
    toolRows: [],
  };
  assert.deepStrictEqual(decideEpoch(stored, grown), { epoch: 0, reason: null });
  // Re-shipping the identical parse is the most common case of all (a --full pass over a
  // settled house): same epoch, and RMT collapses it to nothing.
  const same = { msgRows: grown.msgRows.slice(0, 2), toolRows: [] };
  assert.strictEqual(decideEpoch(stored, same).epoch, 0);
  // A session the house has never seen starts at 0 rather than inventing one.
  assert.deepStrictEqual(decideEpoch(null, grown), { epoch: 0, reason: null });
});

test('a shrunken or rewritten re-parse moves to a new epoch instead of overwriting', () => {
  const { decideEpoch } = require('../memhouse/shipper/ship');
  const stored = {
    epoch: 2, maxSeq: 4, maxIdx: 1,
    hashes: new Map([[0, '111'], [1, '222'], [2, '333'], [3, '444'], [4, '555']]),
    tools: new Map([[0, { tool_name: 'Read', args: '{}' }], [1, { tool_name: 'Edit', args: '{}' }]]),
  };
  const shorter = {
    msgRows: [{ seq: 0, line_hash: '111' }, { seq: 1, line_hash: '222' }, { seq: 2, line_hash: '333' }],
    toolRows: [{ idx: 0, tool_name: 'Read', args: '{}' }, { idx: 1, tool_name: 'Edit', args: '{}' }],
  };
  const shrunk = decideEpoch(stored, shorter);
  assert.strictEqual(shrunk.epoch, 3, 'a shorter parse must not be written over the longer one');
  assert.match(shrunk.reason, /5 messages stored, 3 parsed/);

  // Compaction: same length or longer, but rewritten at a seq the house already holds.
  // Bumping on shrink alone would keep the tail and still lose this — the same data loss,
  // reached through the merge instead of the delete.
  const rewritten = {
    msgRows: [{ seq: 0, line_hash: '111' }, { seq: 1, line_hash: 'DIFFERENT' },
      { seq: 2, line_hash: '333' }, { seq: 3, line_hash: '444' }, { seq: 4, line_hash: '555' }],
    toolRows: shorter.toolRows,
  };
  assert.strictEqual(decideEpoch(stored, rewritten).epoch, 3);
  assert.match(decideEpoch(stored, rewritten).reason, /message 1 was rewritten/);

  // Tool calls carry no line_hash and are compared directly: they come from _toolCalls,
  // which can change while the assistant's text does not.
  const retooled = {
    msgRows: [{ seq: 0, line_hash: '111' }, { seq: 1, line_hash: '222' }, { seq: 2, line_hash: '333' },
      { seq: 3, line_hash: '444' }, { seq: 4, line_hash: '555' }],
    toolRows: [{ idx: 0, tool_name: 'Read', args: '{"path":"a"}' }, { idx: 1, tool_name: 'Edit', args: '{}' }],
  };
  assert.match(decideEpoch(stored, retooled).reason, /tool call 0 was rewritten/);

  // A seq the house does not hold is a gap, not a disagreement: there is nothing there to
  // destroy, so it must not fork the session.
  const gapped = {
    epoch: 0, maxSeq: 4, maxIdx: -1,
    hashes: new Map([[0, '111'], [4, '555']]), tools: new Map(),
  };
  assert.strictEqual(decideEpoch(gapped, {
    msgRows: [{ seq: 0, line_hash: '111' }, { seq: 1, line_hash: 'new' },
      { seq: 2, line_hash: 'new' }, { seq: 3, line_hash: 'new' }, { seq: 4, line_hash: '555' }],
    toolRows: [],
  }).epoch, 0);
});

test('every room type carries an origin column defaulting to ship', () => {
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
  const n = (tpl.match(/origin LowCardinality\(String\) DEFAULT 'ship'/g) || []).length;
  assert.strictEqual(n, rooms.ROOM_TYPES.length,
    `origin must be on all ${rooms.ROOM_TYPES.length} room types, found ${n}`);
});

// ── sorting keys ────────────────────────────────────────────────────────────────
test('the template declares exactly the sorting keys the shipper enforces', () => {
  // The two halves of this used to be able to drift: the keys were written in the
  // template and re-derived by a regex in the shipper and a second regex in doctor. A
  // house built from a template the guard disagrees with is a house that fails at ship
  // time, after install said it was ready.
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
  for (const t of rooms.ROOM_TYPES) {
    const m = tpl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\s*\\([\\s\\S]*?\\nORDER BY \\(([^)]*)\\)`, 'm'));
    assert.ok(m, `no ORDER BY found for room '${t}'`);
    assert.strictEqual(rooms.keyProblem(t, m[1]), null,
      `the template's key for '${t}' is (${m[1]}), which the shipper would refuse`);
  }
});

test('a room missing epoch from its key is refused — that key cannot retain a superseded parse', () => {
  // 0.9.0's keys. Writing a new parse into them means RMT collapses it against the old
  // one, which is the data loss the epoch exists to prevent — so the shipper must refuse
  // rather than write.
  assert.ok(rooms.keyProblem('messages', 'session_id, user_id, origin, seq'));
  assert.ok(rooms.keyProblem('tool_calls', 'session_id, user_id, origin, idx'));
  // And the pre-0.4.4 shape, where an import and a ship collapse into one row.
  assert.ok(rooms.keyProblem('messages', 'session_id, user_id, seq'));
  // sessions must stay one row per session: neither origin nor epoch belongs in its key.
  assert.ok(rooms.keyProblem('sessions', 'session_id, user_id, origin'));
  assert.ok(rooms.keyProblem('sessions', 'session_id, user_id, epoch'));
  assert.strictEqual(rooms.keyProblem('sessions', 'session_id, user_id'), null);
  // A room that exists but reports no sorting key at all is not a MergeTree. Treating
  // that as "nothing to check" printed a green tick over a house where ship then died on
  // `DELETE query is not supported for table …`.
  assert.ok(rooms.keyProblem('messages', ''));
});

test('loadExisting builds its (session, epoch) keys identically at all three sites', () => {
  // One of these was once typed with a space while the other two used U+0000, so the
  // tool-state lookup missed on every call, `tools.n` read 0, and every session with
  // tool calls re-shipped on every pass — measured as 324 of 437, forever. The key
  // builder is one expression at three sites; pin them to each other.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'shipper', 'ship.js'), 'utf-8');
  const keys = src.match(/`\$\{(?:id|r\.session_id)\}[^`]*\$\{epoch\}`/g) || [];
  assert.strictEqual(keys.length, 3, `expected the 3 key sites, found ${keys.length}`);
  const seps = new Set(keys.map((k) => k.replace(/\$\{(?:id|r\.session_id)\}/, '').replace(/\$\{epoch\}/, '')));
  assert.strictEqual(seps.size, 1, `key separators differ across sites: ${JSON.stringify([...seps])}`);
  assert.ok([...seps][0].includes('\\u0000'), 'the separator must be the escaped NUL, not a raw byte or a space');
  // And no raw control bytes anywhere in the file — a literal NUL makes grep call it binary.
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(src), 'ship.js contains a raw control byte');
});

test('the migration registry is ordered, complete, and matches the schema version', () => {
  const mig = require('../memhouse/house/migrate');
  const list = mig.listMigrations();
  assert.ok(list.length >= 1, 'no migrations registered');
  // The registry's last word and house.js's SCHEMA_VERSION must agree — a version bump
  // without a migration strands every existing house behind a refusal with no way
  // forward, and a migration without the bump never runs.
  assert.strictEqual(list[list.length - 1].toVersion, rooms.SCHEMA_VERSION,
    'SCHEMA_VERSION moved without a migration to take houses there (or vice versa)');
  // Every step names an executor that exists — an unknown op is found at 2am otherwise.
  const fakeCtx = { rooms: Object.fromEntries(rooms.ROOM_TYPES.map((t) => [`${t}_raw`, t])) };
  for (const m of list) {
    const found = rooms.ROOM_TYPES.map((t) => ({ t, name: t, key: 'wrong', rebuild: true }));
    for (const step of m.steps(found, fakeCtx)) {
      assert.ok(mig.EXECUTORS[step.op], `migration '${m.id}' names unknown op '${step.op}'`);
    }
    assert.ok(Array.isArray(m.plan(found)), `migration '${m.id}' plan() must return lines`);
  }
});

test('the epoch-key migration heals what it does not rebuild', () => {
  // sessions keeps its sorting key across schema 2 and so is never rebuilt — but it
  // still gains the epoch column. A migration that leaves it behind hands the pilot a
  // "fields are being DISCARDED" warning on the very next ship.
  const m = require('../memhouse/house/migrations/0100-epoch-key');
  const ctx = { rooms: Object.fromEntries(rooms.ROOM_TYPES.map((t) => [`${t}_raw`, t])) };
  const found = [{ t: 'messages', name: 'messages', key: 'old', rebuild: true }, { t: 'tool_calls', name: 'tool_calls', key: 'old', rebuild: true }];
  const steps = m.steps(found, ctx);
  assert.deepStrictEqual(steps.map((x) => x.op), ['rebuildRoom', 'rebuildRoom', 'healColumns']);
  assert.strictEqual(steps[2].name, 'sessions');
});

test('the schema template parser reads the rooms it actually creates', () => {
  // It matched `<type>_{{MEMBER}}` for a whole release after the rooms became plain
  // shared tables, so it returned NOTHING and three surfaces reported success over an
  // empty comparison: ensureSchema's column healer had nothing to add, warnMissingColumns
  // had nothing to warn about, and doctor printed "✓ columns: every room matches the
  // schema template" having compared zero columns.
  const { templateColumns } = require('../memhouse/shipper/ship');
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
  const cols = templateColumns(tpl);
  for (const t of rooms.ROOM_TYPES) {
    const names = (cols[t] || []).map((c) => c.name);
    assert.ok(names.length > 5, `room '${t}' parsed ${names.length} columns`);
    for (const required of ['session_id', 'origin', 'epoch', 'user_id', 'ingested_at']) {
      assert.ok(names.includes(required), `room '${t}' lost '${required}' from the parse`);
    }
    // The clauses are the point: adding user_id without MATERIALIZED gives every row an
    // empty, unforgeable-by-nobody identity.
    const uid = (cols[t] || []).find((c) => c.name === 'user_id');
    assert.match(uid.type, /MATERIALIZED currentUser\(\)/, `'${t}'.user_id lost its stamp`);
    // INDEX declarations are not columns — an ADD COLUMN built from one is a syntax error.
    assert.ok(!names.some((n) => /^(INDEX|idx_)/i.test(n)), `room '${t}' parsed an index as a column`);
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

// ── the SQLite value bridge ─────────────────────────────────────────────────────
// better-sqlite3 returned a Buffer for a BLOB column; node:sqlite returns a plain
// Uint8Array. Buffer.toString() decodes utf-8, so every `JSON.parse(row.value)` in the
// adapters worked on bytes by accident. Uint8Array.toString() renders the byte VALUES
// comma-joined — "123,34,114,…" — which parses as neither JSON nor text and surfaces
// four frames later as a corrupt-store error against a store that is perfectly fine.
// Editor stores are inconsistent about which type they hand back (the VS Code family
// declares ItemTable.value BLOB and usually stores TEXT in it), so this is the seam
// every blob-or-text read goes through.
const sqlitebridge = require('../editors/sqlite');

test('textOf decodes bytes as utf-8, not as a list of byte values', () => {
  const json = JSON.stringify({ role: 'user', content: 'héllo' });
  // The exact thing node:sqlite hands back for a BLOB column.
  const asBytes = new Uint8Array(Buffer.from(json, 'utf-8'));
  assert.strictEqual(sqlitebridge.textOf(asBytes), json);
  assert.deepStrictEqual(JSON.parse(sqlitebridge.textOf(asBytes)).content, 'héllo');
  // The defect this exists to prevent: the bare toString() the adapters used to rely on.
  assert.notStrictEqual(asBytes.toString('utf-8'), json);
  // TEXT columns pass through untouched, and a Buffer still works.
  assert.strictEqual(sqlitebridge.textOf(json), json);
  assert.strictEqual(sqlitebridge.textOf(Buffer.from(json)), json);
  assert.strictEqual(sqlitebridge.textOf(null), null);
});

test('bytesOf gives byte-walkers a Buffer whatever SQLite returned', () => {
  // Cursor walks a blob tree by offset and hex-encodes 32-byte hashes out of it; zed
  // hands its thread blob to zstd. Both need Buffer semantics, not Uint8Array ones.
  const raw = Buffer.from([0x0a, 0x20, 0xde, 0xad, 0xbe, 0xef]);
  const asBytes = new Uint8Array(raw);
  const b = sqlitebridge.bytesOf(asBytes);
  assert.ok(Buffer.isBuffer(b));
  assert.strictEqual(b.slice(2).toString('hex'), 'deadbeef');
  assert.strictEqual(b.length, raw.length);
  assert.strictEqual(sqlitebridge.bytesOf(raw), raw, 'a Buffer is returned as-is, not copied');
});

test('SQLite is part of Node — there is no binding that can go missing', () => {
  // The whole reason `--allow-scripts=better-sqlite3` existed, and the reason five
  // adapters could report zero sessions on a healthy machine. If this ever throws, the
  // engines floor in package.json is wrong for the Node running the tests.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a)');
  db.close();
  // And getAdapterErrors no longer carries the flag that class was reported through.
  const errs = require('../editors').getAdapterErrors();
  assert.ok(Array.isArray(errs));
  assert.ok(errs.every((e) => !('missingBinding' in e)), 'missingBinding died with the native dep');
});

// ── relocate: the pure decisions of the host-to-host copy ─────────────────────────
const relocate = require('../memhouse/house/relocate');

test('nativeEndpoint derives the TLS native port from an HTTP url', () => {
  const e = relocate.nativeEndpoint('https://test.memhouse.io:8443');
  assert.strictEqual(e.fn, 'remoteSecure');
  assert.strictEqual(e.addr, 'test.memhouse.io:9440', 'native TLS default is 9440, not the HTTP port');
});

test('nativeEndpoint --insecure-native drops to remote() + 9000', () => {
  const e = relocate.nativeEndpoint('http://box.local:8123', { insecure: true });
  assert.strictEqual(e.fn, 'remote');
  assert.strictEqual(e.addr, 'box.local:9000');
});

test('nativeEndpoint honours an explicit port override', () => {
  assert.strictEqual(relocate.nativeEndpoint('http://h:8123', { port: 19440 }).addr, 'h:19440');
});

test('nativeEndpoint honours a host override — the destination route can differ', () => {
  // The pilot reaches the source at test.memhouse.io; the DESTINATION may reach it by a
  // private peering name. The copy must use the destination's route, not the pilot's.
  const e = relocate.nativeEndpoint('https://test.memhouse.io:8443', { host: 'source.internal', port: 9440 });
  assert.strictEqual(e.addr, 'source.internal:9440');
});

test('nativeEndpoint rejects a non-url source', () => {
  assert.throws(() => relocate.nativeEndpoint('not a url'), /not a url|no host/);
});

test('copyColumns carries the intersection minus the derived text indexes', () => {
  // user_id (MATERIALIZED but stored) MUST be carried so a shared house is not restamped;
  // text_ngram/text_word MUST NOT be — the destination recomputes them on insert.
  const dest = ['session_id', 'user_id', 'text', 'text_ngram', 'text_word', 'epoch'];
  const src = ['session_id', 'user_id', 'text', 'text_ngram', 'text_word', 'epoch', 'legacy_col'];
  const cols = relocate.copyColumns(dest, src);
  assert.deepStrictEqual(cols, ['session_id', 'user_id', 'text', 'epoch']);
  assert.ok(cols.includes('user_id'), 'provenance is carried, never restamped');
  assert.ok(!cols.includes('text_ngram') && !cols.includes('text_word'), 'derived columns are recomputed, not copied');
  assert.ok(!cols.includes('legacy_col'), 'a source-only column the destination lacks is dropped');
});

test('copyColumns order follows the destination so SELECT and INSERT line up', () => {
  assert.deepStrictEqual(relocate.copyColumns(['b', 'a'], ['a', 'b']), ['b', 'a']);
});

test('isDurableMetaKey keeps facts, drops per-host heartbeats', () => {
  assert.ok(relocate.isDurableMetaKey('schema_version'));
  assert.ok(relocate.isDurableMetaKey('min_writer_schema'));
  assert.ok(relocate.isDurableMetaKey('share:alice'));
  assert.ok(!relocate.isDurableMetaKey('last_ship:polat'), 'the new shipper rewrites its own heartbeat');
  assert.ok(!relocate.isDurableMetaKey('client_version'));
});

// ── hidden input: a chunk is not a keystroke ────────────────────────────────────
// A raw-mode 'data' event carries however many characters arrived at once. The handler
// used to compare the WHOLE chunk against a terminator, which is right while someone
// types (one char per event) and hangs forever the moment they paste — the exact way a
// password out of a manager arrives. Caught by driving the real prompt through a pty.
test('a pasted line resolves, and the terminator is not part of the secret', () => {
  const r = consumeSecretChunk('', 'hunter2\r');
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.buf, 'hunter2');
});

test('typing one character at a time still accumulates', () => {
  let buf = '';
  for (const ch of 'pw') { const r = consumeSecretChunk(buf, ch); buf = r.buf; assert.strictEqual(r.done, false); }
  assert.strictEqual(buf, 'pw');
  assert.strictEqual(consumeSecretChunk(buf, '\r').done, true);
});

test('LF and EOT terminate as well as CR', () => {
  assert.strictEqual(consumeSecretChunk('', 'a\n').done, true);
  assert.strictEqual(consumeSecretChunk('', 'a\u0004').done, true);
});

test('anything after the terminator is discarded, not leaked into the secret', () => {
  const r = consumeSecretChunk('', 'secret\rleftover');
  assert.strictEqual(r.buf, 'secret');
  assert.strictEqual(r.done, true);
});

test('backspace erases inside a chunk', () => {
  assert.strictEqual(consumeSecretChunk('', 'abX\u007fc').buf, 'abc');
});

test('ctrl-C is reported, never swallowed into the secret', () => {
  const r = consumeSecretChunk('ab', 'c\u0003d');
  assert.strictEqual(r.interrupted, true);
  assert.strictEqual(r.done, false);
});

test('an empty chunk changes nothing', () => {
  const r = consumeSecretChunk('abc', '');
  assert.deepStrictEqual([r.buf, r.done, r.interrupted], ['abc', false, false]);
});

// ── who may provision: scope is the whole point ─────────────────────────────────
// The probe this replaces asked `SELECT 1 FROM system.users`, which every member passes
// because every member holds SHOW USERS — so every member was told it could manage
// users, then died at CREATE DATABASE. The replacement must read grants, and it must
// respect SCOPE: a member holds CREATE DATABASE inside `ON <their-db>.*`, which mints
// nothing.
const MEMBER = [
  'GRANT SHOW USERS ON *.* TO m',
  'GRANT REMOTE ON *.* TO m',
  'GRANT ALTER USER ON m TO m',
  'GRANT CHECK, SHOW, SELECT, INSERT, ALTER, CREATE DATABASE, CREATE TABLE, DROP DATABASE ON m.* TO m WITH GRANT OPTION',
  'GRANT SELECT ON friend.* TO m',
];
const SUPERUSER = [
  'GRANT SOURCES ON *.* TO s WITH GRANT OPTION',
  'GRANT CHECK, SHOW, SELECT, INSERT, ALTER, CREATE, DROP, ROLE ADMIN, SYSTEM ON *.* TO s WITH GRANT OPTION',
  'GRANT CREATE USER, ALTER USER, DROP USER, IMPERSONATE ON * TO s WITH GRANT OPTION',
];

test('a member cannot provision, however many privileges it holds on its own house', () => {
  const c = capabilitiesFrom(MEMBER);
  assert.strictEqual(c.canProvision, false);
  assert.strictEqual(c.canMintHouses, false, 'CREATE DATABASE ON m.* is not server-wide');
  assert.strictEqual(c.canMintUsers, false);
  assert.strictEqual(c.canReadEveryHouse, false, 'SELECT ON friend.* is one share, not the server');
});

test('SHOW USERS alone never reads as administrator — the original bug', () => {
  const c = capabilitiesFrom(['GRANT SHOW USERS ON *.* TO m']);
  assert.strictEqual(c.canSeeUsers, true);
  assert.strictEqual(c.canProvision, false);
});

test('a superuser is recognised through the umbrella spellings', () => {
  const c = capabilitiesFrom(SUPERUSER);
  assert.strictEqual(c.canProvision, true, 'bare CREATE on *.* plus CREATE USER on *');
  assert.strictEqual(c.isSuperuser, true);
});

test('ACCESS MANAGEMENT stands in for CREATE USER', () => {
  const c = capabilitiesFrom([
    'GRANT ACCESS MANAGEMENT ON *.* TO a',
    'GRANT CREATE DATABASE ON *.* TO a',
  ]);
  assert.strictEqual(c.canProvision, true);
});

test('GRANT ALL on *.* provisions; GRANT ALL on one house does not', () => {
  assert.strictEqual(capabilitiesFrom(['GRANT ALL ON *.* TO a', 'GRANT CREATE USER ON * TO a']).canProvision, true);
  assert.strictEqual(capabilitiesFrom(['GRANT ALL ON just_mine.* TO a']).canProvision, false);
});

test('unreadable grants are not an administrator', () => {
  const c = capabilitiesFrom([]);
  assert.strictEqual(c.canProvision, false);
  assert.strictEqual(c.isSuperuser, false);
});

test('grant lines parse into privileges and scope', () => {
  const g = parseGrantLine('GRANT CREATE USER, DROP USER ON * TO bob WITH GRANT OPTION');
  assert.deepStrictEqual(g.privs, ['CREATE USER', 'DROP USER']);
  assert.strictEqual(g.scope, '*');
  assert.strictEqual(parseGrantLine('not a grant'), null);
});

// ── option validation ───────────────────────────────────────────────────────────
// Unknown flags used to be accepted and ignored, which is quiet in the good case and
// dangerous in the bad one: `--dryrun` for `--dry-run` ran the migration for real.
test('a typo is refused, and names the flag it probably meant', () => {
  assert.deepStrictEqual(flagspec.unknownFlags('whoami', { admina: true }), ['admina']);
  assert.strictEqual(flagspec.suggestFlag('admina', flagspec.allowedFlags('whoami')), 'admin');
  assert.strictEqual(flagspec.suggestFlag('dryrun', flagspec.allowedFlags('migrate')), 'dry-run');
  assert.strictEqual(flagspec.suggestFlag('adop', flagspec.allowedFlags('invite')), 'adopt');
});

test('a flag that resembles nothing gets no invented suggestion', () => {
  assert.strictEqual(flagspec.suggestFlag('completelyunrelated', flagspec.allowedFlags('whoami')), null);
});

test('global flags are accepted everywhere', () => {
  for (const cmd of Object.keys(flagspec.COMMAND_FLAGS)) {
    assert.deepStrictEqual(
      flagspec.unknownFlags(cmd === 'null' ? null : cmd, { json: true, yes: true }), [],
      `${cmd} rejected a global flag`);
  }
});

test('an unknown COMMAND is left to dispatch, not reported as a flag problem', () => {
  assert.deepStrictEqual(flagspec.unknownFlags('nosuchcommand', { whatever: true }), []);
});

test('every declared flag is accepted by its own command', () => {
  for (const [cmd, list] of Object.entries(flagspec.COMMAND_FLAGS)) {
    const f = {};
    for (const x of list) f[x] = true;
    assert.deepStrictEqual(flagspec.unknownFlags(cmd === 'null' ? null : cmd, f), [],
      `${cmd} rejected one of its own flags`);
  }
});

// The table is a promise about the CLI, so hold it against the CLI. A flag added to the
// code and not to the table would otherwise be refused the first time a user typed it.
test('every flag the CLI reads is declared for some command', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'memhouse.js'), 'utf-8');
  const used = new Set();
  for (const m of src.matchAll(/flags\['([a-z-]+)'\]/g)) used.add(m[1]);
  // (?<!\/) so `memhouse/flags.js` in a comment is not mistaken for a flag named `js`.
  for (const m of src.matchAll(/(?<!\/)\bflags\.([a-zA-Z][a-zA-Z0-9]*)/g)) used.add(m[1]);
  const declared = new Set(flagspec.GLOBAL_FLAGS);
  for (const list of Object.values(flagspec.COMMAND_FLAGS)) for (const f of list) declared.add(f);
  const missing = [...used].filter((f) => !declared.has(f));
  assert.deepStrictEqual(missing, [],
    `these flags are read by bin/memhouse.js but declared for no command: ${missing.join(', ')}`);
});

if (process.exitCode) console.error(`\n${passed} passed, some failed`);
else console.log(`${passed}/${passed} unit checks pass`);
