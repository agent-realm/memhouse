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
const share = require('../memhouse/share');
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
test('rooms are named for the member — one layout, one grant pattern', () => {
  const r = rooms.roomNames('alice');
  assert.strictEqual(r.sessions_raw, 'alice_sessions');
  assert.strictEqual(r.messages_raw, 'alice_messages');
  assert.strictEqual(r.tool_calls_raw, 'alice_tool_calls');
  assert.strictEqual(r.pattern, 'alice_*', 'the grant is scoped to this pattern and nothing else');
  assert.throws(() => rooms.roomNames(''), /member is required/, 'a room without a member is not a thing');
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
  assert.strictEqual(r.sessions, 'alice_sessions');
});

test('the session rollup is a QUERY, not a fourth object', () => {
  const r = rooms.roomNames('alice');
  // SQL text, substituted into the same `FROM ... AS c` position a view name would hold.
  assert.ok(r.sessions_v.startsWith('('), 'the rollup must be a subquery');
  assert.ok(r.sessions_v.includes('FROM alice_sessions AS s'), r.sessions_v);
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
  assert.match(v, /FROM alice_sessions AS s FINAL/, 'sessions must be read FINAL');
  // The messages side carries its FINAL INSIDE the current-parse subquery instead —
  // `FROM (SELECT …) AS m FINAL` does not parse, and appending FINAL to whatever the room
  // resolved to is exactly the trap the raw/filtered split exists to remove.
  assert.match(v, /LEFT JOIN \(\s*\n\s*SELECT \*/, 'messages must join as the current-parse subquery');
  assert.match(v, /FROM alice_messages FINAL/, 'the current-parse subquery must read FINAL');
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

test('a bump on a sparse session counts rows, not the highest seq (A4)', () => {
  const { decideEpoch } = require('../memhouse/shipper/ship');
  // A subagent block puts seq near 1e9; the log once read "1000000002 messages stored".
  const sub = 1000000000;
  const stored = {
    epoch: 3, maxSeq: sub + 1, maxIdx: -1,
    hashes: new Map([[0, 'a'], [1, 'b'], [sub, 'c'], [sub + 1, 'd']]),
    tools: new Map(),
  };
  const shrunk = { msgRows: [{ seq: 0, line_hash: 'a' }, { seq: 1, line_hash: 'b' }], toolRows: [] };
  const d = decideEpoch(stored, shrunk);
  assert.strictEqual(d.epoch, 4);
  assert.match(d.reason, /^4 messages stored, 2 parsed, 2 of them not in the new parse$/, d.reason);
});

test('tailRows sends the tail, not the transcript, when nothing in the overlap moved', () => {
  const { tailRows } = require('../memhouse/shipper/ship');
  // The defect this fixes: a growing session re-parsed and re-sent WHOLE on every pass.
  // ReplacingMergeTree took every copy, so a real 1,230-session house held 1,226,770 rows
  // for 685,649 real ones — 1.79 copies of the average row, seven of the worst — and every
  // read carries final=1, so the dashboard paid for all of them.
  const stored = {
    hashes: new Map([[0, '111'], [1, '222']]),
    tools: new Map([[0, { tool_name: 'Read', args: '{}' }]]),
  };
  const grown = {
    msgRows: [{ seq: 0, line_hash: '111' }, { seq: 1, line_hash: '222' }, { seq: 2, line_hash: '333' }],
    toolRows: [{ idx: 0, tool_name: 'Read', args: '{}' }, { idx: 1, tool_name: 'Edit', args: '{}' }],
  };
  const sent = tailRows(stored, grown);
  assert.deepStrictEqual(sent.msgRows.map((r) => r.seq), [2]);
  assert.deepStrictEqual(sent.toolRows.map((r) => r.idx), [1]);

  // Re-shipping a settled session sends NOTHING. This is the case that ran every five
  // minutes, forever, on every session the pilot still had open.
  const settled = tailRows(stored, {
    msgRows: grown.msgRows.slice(0, 2), toolRows: grown.toolRows.slice(0, 1),
  });
  assert.deepStrictEqual(settled.msgRows, []);
  assert.deepStrictEqual(settled.toolRows, []);

  // line_hash is a UInt64 on the row and a string out of the house. Comparing them
  // without the coercion would find every row "changed" and send the transcript anyway —
  // the fix would be inert and nothing would fail.
  assert.deepStrictEqual(
    tailRows({ hashes: new Map([[0, '111']]), tools: new Map() },
      { msgRows: [{ seq: 0, line_hash: 111 }], toolRows: [] }).msgRows, []);

  // A gap the house is missing — a pass that died mid-flush — is NOT in the hash map, so
  // it is kept and the next pass repairs itself. Without this the hole would be permanent.
  const gapped = tailRows(
    { hashes: new Map([[0, '111'], [2, '333']]), tools: new Map() },
    { msgRows: [{ seq: 0, line_hash: '111' }, { seq: 1, line_hash: '222' }, { seq: 2, line_hash: '333' }], toolRows: [] });
  assert.deepStrictEqual(gapped.msgRows.map((r) => r.seq), [1]);

  // Belt and braces: a changed row in the overlap is kept. decideEpoch forks the session
  // before this ever runs, so this can only fire if that guard is bypassed — and sending
  // the row is the safe direction to be wrong in.
  const changed = tailRows(stored, {
    msgRows: [{ seq: 0, line_hash: 'DIFFERENT' }], toolRows: [{ idx: 0, tool_name: 'Read', args: '{"p":1}' }],
  });
  assert.deepStrictEqual(changed.msgRows.map((r) => r.seq), [0]);
  assert.deepStrictEqual(changed.toolRows.map((r) => r.idx), [0]);
});

test('tailSafe refuses the tail path for the columns line_hash cannot see', () => {
  const { tailSafe } = require('../memhouse/shipper/ship');
  const rows = { tsInterpolated: false, session: { folder: '/w/p' } };
  const prev = { host: 'macminim-1', folder: '/w/p' };
  assert.ok(tailSafe(prev, rows, 'macminim-1'));

  // ts is interpolated as seq/(total-1) for adapters with no per-message time, so EVERY
  // stored row's ts moves when the session grows. Those must keep re-shipping whole.
  assert.ok(!tailSafe(prev, { ...rows, tsInterpolated: true }, 'macminim-1'));
  // A second machine shipping the same session keeps overwriting, as it does today.
  assert.ok(!tailSafe(prev, rows, 'macbokum-2'));
  // folder/project is denormalized onto every message row; a moved project must reach them.
  assert.ok(!tailSafe({ ...prev, folder: '/w/old' }, rows, 'macminim-1'));
  // Absent on both sides is agreement, not a mismatch — sessions shipped before these
  // columns carried anything must not re-ship whole forever.
  assert.ok(tailSafe({ host: 'macminim-1' }, { tsInterpolated: false, session: {} }, 'macminim-1'));
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
  // THE bug in the FIRST derived scheme: two laptops with the same default hostname on the
  // same platform and arch hashed to one id, so their sessions merged into a single
  // apparent host. The fingerprint is derived again — but from the machine's OWN id
  // (IOPlatformUUID / machine-id), which two laptops never share, and hostname, platform
  // and arch feed nothing. Two homes on ONE machine now deliberately agree, so the old
  // way of staging this (two temp homes) no longer stages two machines; the raw id does.
  assert.notStrictEqual(hostjs.machineFingerprint('uuid-of-laptop-A'), hostjs.machineFingerprint('uuid-of-laptop-B'),
    'different machines must not collide');
  assert.strictEqual(hostjs.machineFingerprint('uuid-of-laptop-A'), hostjs.machineFingerprint('uuid-of-laptop-A'),
    'and the same machine must agree with itself');
  assert.match(hostjs.machineFingerprint('uuid-of-laptop-A'), /^[0-9a-f]{32}$/);
  assert.ok(!hostjs.machineFingerprint('uuid-of-laptop-A').includes('uuid'), 'the raw id is hashed, never stored');
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

// ── partial sharing: scopes and policy names ────────────────────────────────────
// A scoped share is three row policies that must agree. The rooms do not all spell time
// the same way — `sessions` has no `ts`, its clock is `created_at` — so one literal
// predicate cannot span them, and a mismatch means a share that filters messages while
// leaking tool_calls.
const q = (x) => "'" + String(x).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

test('time scopes use each room\'s own clock column', () => {
  const sc = share.parseScope('since=2026-08-01');
  assert.match(share.scopePredicate(sc, 'messages', q), /^ts >=/);
  assert.match(share.scopePredicate(sc, 'tool_calls', q), /^ts >=/);
  assert.match(share.scopePredicate(sc, 'sessions', q), /^created_at >=/,
    'sessions has no ts column — a shared predicate would fail or filter nothing');
});

test('identity scopes are identical across all three rooms', () => {
  for (const key of ['session', 'project', 'folder', 'host', 'source']) {
    const sc = share.parseScope(`${key}=x`);
    const preds = ['sessions', 'messages', 'tool_calls'].map((r) => share.scopePredicate(sc, r, q));
    assert.strictEqual(new Set(preds).size, 1, `${key} rendered differently per room`);
  }
});

test('scopes combine with AND', () => {
  const sc = share.parseScope('project=memhouse,since=2026-08-01');
  assert.strictEqual(share.scopePredicate(sc, 'messages', q),
    "project = 'memhouse' AND ts >= parseDateTimeBestEffort('2026-08-01')");
});

test('values are escaped, never spliced raw', () => {
  const sc = share.parseScope("project=O'Reilly");
  assert.ok(share.scopePredicate(sc, 'messages', q).includes("O\\'Reilly"),
    'a quote in a project name must not break out of the literal');
});

test('an unknown or malformed scope is refused, and says what is valid', () => {
  assert.throws(() => share.parseScope('nope=1'), /unknown scope key/);
  assert.throws(() => share.parseScope('project'), /not <key>=<value>/);
  assert.throws(() => share.parseScope(''), /nothing to scope on/);
});

test('policy names are predictable, so revoke finds every room', () => {
  const names = ['sessions', 'messages', 'tool_calls'].map((r) => share.policyName('alice', r));
  assert.deepStrictEqual(names,
    ['mh_share_alice_sessions', 'mh_share_alice_messages', 'mh_share_alice_tool_calls']);
  assert.strictEqual(new Set(names).size, 3);
});

// ── one layout: every member's rooms carry their name, and one grant covers them ────────
// The product rests on a colleague being able to read their isolation back with SHOW
// GRANTS. That works only if there is exactly one shape of grant, and only if every
// table name in the codebase comes from the same function — so both are asserted here.
test('physicalRoom refuses to name a room without a member', () => {
  assert.throws(() => rooms.physicalRoom('messages'), /a member/, 'there is no unprefixed room any more');
  assert.throws(() => rooms.physicalRoom('messages', ''), /a member/);
  assert.strictEqual(rooms.physicalRoom('meta', 'bob'), 'bob_meta');
});

test('the epoch subquery reads the member\'s room, and tool_calls takes its epoch from MESSAGES', () => {
  const r = rooms.roomNames('alice');
  const m = r.messages.replace(/\s+/g, ' ');
  const t = r.tool_calls.replace(/\s+/g, ' ');
  assert.ok(/FROM alice_messages FINAL/.test(m), 'the outer read must be the member\'s room');
  assert.ok(!/FROM messages\b/.test(m), 'a bare `messages` would be someone else\'s layout');
  assert.ok(/FROM alice_tool_calls FINAL/.test(t));
  // A parse producing messages but no tool calls writes nothing into tool_calls at the new
  // epoch; asked for its own max(epoch) that room would answer with the superseded one.
  assert.ok(/FROM alice_messages WHERE origin/.test(t), 'epoch source must be the member\'s messages room');
});

const provision = require('../memhouse/provision');
test('the provisioning plan is ONE grant on the member\'s pattern, and never the database', () => {
  const steps = provision.plan({ db: 'mem', member: 'alice', password: 'pw' });
  const sql = steps.map((s) => s.sql);
  const grants = sql.filter((q) => q.startsWith('GRANT') && / ON mem\./.test(q));
  assert.strictEqual(grants.length, 1, `exactly one grant inside the house, got: ${grants.join(' | ')}`);
  assert.match(grants[0], /ON mem\.alice_\* TO alice WITH GRANT OPTION$/, 'scoped to alice_*, with grant option so she can share it');
  assert.ok(!sql.some((q) => /ON mem\.\* /.test(q)), 'ALL ON db.* is dynamic — it covers rooms created later — and is what made two members in one database a leak');
  // What the grant must carry, each for a reason the comments in provision.js give.
  for (const priv of ['CREATE TABLE', 'DROP TABLE', 'CREATE ROW POLICY']) {
    assert.ok(grants[0].includes(priv), `${priv} — without it the member cannot build/rebuild their rooms or scope a share`);
  }
  // The pin is required, not optional: an async insert stores user_id as the empty string.
  const pin = steps.find((s) => /ADD SETTING/.test(s.sql));
  assert.ok(pin && !pin.optional, 'async_insert pin must be a required step');
  // A member that already exists: the plan omits CREATE USER and keeps everything else.
  const again = provision.plan({ db: 'mem', member: 'alice' }).map((s) => s.sql);
  assert.ok(!again.some((q) => q.startsWith('CREATE USER')));
  assert.ok(again.some((q) => q.startsWith('GRANT') && /alice_\*/.test(q)));
});

test('the printed plan and the executed plan are the same statements', () => {
  // --print-sql used to be a second description of provisioning and drifted from the first
  // — it printed the leaking shape while the live path refused it. Now it renders the same
  // array the live path executes, so this asserts the rendering carries every statement.
  const steps = provision.plan({ db: 'mem', member: 'alice', password: "p'w" });
  const text = provision.render(steps, { db: 'mem', member: 'alice' });
  for (const s of steps) assert.ok(text.includes(`${s.sql};`), `rendered SQL must carry: ${s.sql.slice(0, 50)}`);
  assert.ok(text.includes("IDENTIFIED BY 'p\\'w'"), 'the password must be escaped for SQL');
  assert.ok(!/ON mem\.\* /.test(text));
  assert.ok(/Do NOT widen it to/.test(text), 'the rendered plan must warn the DBA off the database-wide grant');
});

test('a name that would break the pattern is refused before it reaches SQL', () => {
  assert.throws(() => provision.plan({ db: 'mem', member: 'al ice', password: 'x' }));
  assert.throws(() => provision.plan({ db: 'system', member: 'alice', password: 'x' }), /system|reserved/i);
});

// ── the text-index grammar changed between 25.8 and 26.x, and neither side parses the other ──
test('the legacy dialect rewrites exactly the two index clauses and nothing else', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'memhouse', 'house', 'schema.sql.tpl'), 'utf8');
  const modern = rooms.createStatement(tpl, 'messages', 'alice_messages');
  const legacy = rooms.legacyTextIndexDialect(modern);
  assert.ok(modern.includes("tokenizer = ngrams(3)") && modern.includes('tokenizer = splitByNonAlpha'), 'template carries the current grammar');
  assert.ok(legacy.includes("tokenizer = 'ngram', ngram_size = 3"), 'ngram clause rewritten');
  assert.ok(legacy.includes("tokenizer = 'default'"), 'word clause rewritten');
  assert.ok(!/ngrams\(|splitByNonAlpha/.test(legacy), 'no modern grammar left');
  // Everything else byte-identical: same columns, same engine, same key.
  const strip = (q) => q.replace(/^\s*INDEX .*$/gm, 'INDEX …');
  assert.strictEqual(strip(legacy), strip(modern));
  assert.strictEqual(rooms.legacyTextIndexDialect(rooms.createStatement(tpl, 'sessions', 'alice_sessions')), rooms.createStatement(tpl, 'sessions', 'alice_sessions'), 'a room without text indexes is untouched');
});

test('only a grammar refusal triggers the legacy dialect', () => {
  assert.ok(rooms.isTextIndexGrammarRefusal('Code: 80. DB::Exception: Expected literal. (INCORRECT_QUERY)'));
  assert.ok(rooms.isTextIndexGrammarRefusal("Text index argument 'tokenizer' supports only 'default', 'ngram'"));
  assert.ok(!rooms.isTextIndexGrammarRefusal('Not enough privileges. To execute this query'), 'a privilege refusal must stay a privilege refusal');
  assert.ok(!rooms.isTextIndexGrammarRefusal('Table already exists'));
});

test('the grammar is chosen by version: 25.9 and below legacy, 25.10 and up current', () => {
  for (const [v, want] of [['25.8.28.1', 'legacy'], ['25.9.7.56', 'legacy'], ['24.3.1', 'legacy'], ['25.10.7.6', 'modern'], ['25.11.9.34', 'modern'], ['26.8.2.7', 'modern'], ['', 'modern'], ['nonsense', 'modern']]) {
    assert.strictEqual(rooms.textIndexDialectFor(v), want, `version '${v}'`);
  }
});

// ── scope: which sessions ship ─────────────────────────────────────────────────────────
const scope = require('../editors/scope');
test('an empty scope is everything; a named scope is exactly those, in order; a typo throws', () => {
  const eds = [{ name: 'claude' }, { name: 'codex' }, { name: 'cursor' }];
  assert.deepStrictEqual(scope.selectEditors(eds, ''), eds);
  assert.deepStrictEqual(scope.selectEditors(eds, ' codex , claude ').map((e) => e.name), ['codex', 'claude']);
  assert.throws(() => scope.selectEditors(eds, 'claude,cluade'), /cluade.*Known: claude, codex, cursor/s);
});

test('claude roots: explicit list replaces discovery and every path must be a real config dir', () => {
  const fsx = { exists: (p) => p.endsWith('/one/history.jsonl'), isDir: (p) => ['/one', '/two', '/two/projects', '/plain'].includes(p) };
  assert.deepStrictEqual(scope.selectClaudeRoots(['/a', '/b'], '', fsx), ['/a', '/b']);
  assert.deepStrictEqual(scope.selectClaudeRoots(['/a', '/b'], '/one,/two', fsx), ['/one', '/two']);
  assert.throws(() => scope.selectClaudeRoots(['/a'], '/plain', fsx), /not a Claude Code config dir/);
  assert.throws(() => scope.selectClaudeRoots(['/a'], '/missing', fsx), /not a directory/);
  assert.ok(scope.expandHome('~/.claude-playbooks/x').startsWith(require('os').homedir()));
});

test('the scope reads back as one line', () => {
  assert.strictEqual(scope.describe({}), 'everything this machine has');
  assert.strictEqual(scope.describe({ MEMHOUSE_EDITORS: 'claude', MEMHOUSE_CLAUDE_ROOTS: '~/.claude-playbooks/kommander-chaos' }), 'editors: claude; claude roots: ~/.claude-playbooks/kommander-chaos');
});

test('every adapter has one override variable, named from its adapter name', () => {
  assert.strictEqual(scope.keyFor('codex'), 'MEMHOUSE_CODEX_ROOTS');
  assert.strictEqual(scope.keyFor('gemini-cli'), 'MEMHOUSE_GEMINI_CLI_ROOTS');
  assert.strictEqual(scope.keyFor('claude'), 'MEMHOUSE_CLAUDE_ROOTS');
  const isDir = (p) => p === '/real';
  assert.deepStrictEqual(scope.selectRoot('/dflt', '', { isDir }), { root: '/dflt', error: null });
  assert.deepStrictEqual(scope.selectRoot('/dflt', '/real', { isDir }), { root: '/real', error: null });
  assert.match(scope.selectRoot('/dflt', '/nope', { isDir }).error, /not a directory/);
  assert.match(scope.selectRoot('/dflt', '/real,/real', { isDir }).error, /one directory, 2 given/);
  // A refused override must not fall back to the default — that would ship the wrong store.
  assert.strictEqual(scope.selectRoot('/dflt', '/nope', { isDir }).root, null);
});

// ── update follows the channel it came from ─────────────────────────────────────────────
const channel = require('../memhouse/channel');
test('a build published under another tag is never downgraded to latest', () => {
  const tags = { latest: '0.17.0', team: '0.18.0' };
  const p = channel.pickChannel({ version: '0.18.0', tags });
  assert.strictEqual(p.channel, 'team'); assert.strictEqual(p.target, '0.18.0');
  const q = channel.pickChannel({ version: '0.17.0', tags });
  assert.strictEqual(q.channel, 'latest'); assert.strictEqual(q.target, '0.17.0');
});
test('a pinned channel wins, and says so when the tag does not exist', () => {
  const tags = { latest: '0.17.0', team: '0.18.0' };
  assert.strictEqual(channel.pickChannel({ version: '0.17.0', pinned: 'team', tags }).channel, 'team');
  const p = channel.pickChannel({ version: '0.18.0', pinned: 'nope', tags });
  assert.strictEqual(p.channel, 'nope'); assert.strictEqual(p.target, null); assert.match(p.reason, /not a tag/);
});
test('a tarball or checkout build gets no automatic update', () => {
  const p = channel.pickChannel({ version: '0.18.0-nightly.20260906T0307', tags: { latest: '0.17.0' } });
  assert.strictEqual(p.channel, null); assert.match(p.reason, /tarball|checkout/);
  const q = channel.pickChannel({ version: '0.18.0-alpha.1', tags: { latest: '0.17.0', team: '0.18.0-alpha.1' } });
  assert.strictEqual(q.channel, 'team', 'a pre-release that IS a published tag follows it');
});
test('no registry answer: no channel and no target — never guess a line', () => {
  const p = channel.pickChannel({ version: '0.17.0', tags: null });
  assert.strictEqual(p.channel, null); assert.strictEqual(p.target, null); assert.match(p.reason, /did not answer/);
});

// ── a playbook is bound to the instance that installed its plugin ────────────────────────
const binding = require('../memhouse/binding');
test('binding stamps two env keys and leaves everything else in settings.json alone', () => {
  const before = { hooks: { SessionStart: [{ command: 'x' }] }, env: { FOO: 'bar' }, permissions: { allow: ['Bash'] } };
  const after = binding.bindSettings(before, { home: '/h', bin: '/b' });
  assert.deepStrictEqual(after.hooks, before.hooks); assert.deepStrictEqual(after.permissions, before.permissions);
  assert.deepStrictEqual(after.env, { FOO: 'bar', MEMHOUSE_HOME: '/h', MEMHOUSE_BIN: '/b' });
  assert.deepStrictEqual(binding.boundTo(after), { home: '/h', bin: '/b' });
  assert.strictEqual(binding.boundTo(before), null);
  assert.strictEqual(binding.bindSettings(null, { home: '/h', bin: '/b' }).env.MEMHOUSE_HOME, '/h', 'no settings.json yet is fine');
});
test('unbinding removes only the two keys, and an emptied env block goes with them', () => {
  const bound = binding.bindSettings({ env: { FOO: 'bar' } }, { home: '/h', bin: '/b' });
  assert.deepStrictEqual(binding.unbindSettings(bound).env, { FOO: 'bar' });
  assert.ok(!('env' in binding.unbindSettings(binding.bindSettings({}, { home: '/h', bin: '/b' }))));
  assert.deepStrictEqual(binding.unbindSettings({ hooks: {} }), { hooks: {} }, 'unbinding an unbound file is a no-op');
});

test('an instance is named by its home, or by MEMHOUSE_NAME', () => {
  assert.strictEqual(binding.instanceName('/Users/p/.memhouse'), 'default');
  assert.strictEqual(binding.instanceName('/Users/p/.memhouse-stage'), 'stage');
  assert.strictEqual(binding.instanceName('/Users/p/.memhouse-team/'), 'team');
  assert.strictEqual(binding.instanceName('/Users/p/alice-sandbox/memhouse'), 'memhouse');
  assert.strictEqual(binding.instanceName('/Users/p/.memhouse-stage', 'santiment'), 'santiment');
});

// ── bare `memhouse` beside an invite file ────────────────────────────────────────────────
const invitefile = require('../memhouse/invitefile');
test('an invite file is recognised by name and read without its secret', () => {
  const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mh-inv-'));
  fs.writeFileSync(path.join(d, 'invite-alice.env'), "MEMHOUSE_URL='http://h:1'\nMEMHOUSE_USER='alice'\nMEMHOUSE_PASSWORD='s3cret'\nMEMHOUSE_DB='mem'\nMEMHOUSE_INVITE='1'\nMEMHOUSE_CHANNEL='team'\n");
  fs.writeFileSync(path.join(d, 'notes.env'), 'x=1'); fs.writeFileSync(path.join(d, 'invite-bad name.env'), 'x=1');
  const found = invitefile.findInvites([d, '/nope']);
  assert.deepStrictEqual(found.map((f) => path.basename(f.file)), ['invite-alice.env'], 'only invite-<name>.env, and a missing dir is skipped');
  const desc = invitefile.describeInvite(fs.readFileSync(found[0].file, 'utf-8'));
  assert.deepStrictEqual({ user: desc.user, url: desc.url, db: desc.db, channel: desc.channel, isInvite: desc.isInvite, complete: desc.complete }, { user: 'alice', url: 'http://h:1', db: 'mem', channel: 'team', isInvite: true, complete: true });
  assert.ok(!JSON.stringify(desc).includes('s3cret'), 'the description never carries the password');
  assert.deepStrictEqual(invitefile.describeInvite("MEMHOUSE_URL='x'").missing, ['MEMHOUSE_USER', 'MEMHOUSE_PASSWORD', 'MEMHOUSE_DB']);
  fs.rmSync(d, { recursive: true });
});

// ── a rotated credential must reach the process that was spawned with the old one ───────
test('credentialDrift reports exactly the env-file values a process no longer matches', () => {
  const envfile = require('../memhouse/envfile');
  const text = "MEMHOUSE_URL='http://h:1'\nMEMHOUSE_USER='mira'\nMEMHOUSE_PASSWORD='new'\nMEMHOUSE_DB='mem'\n";
  const d = envfile.credentialDrift(text, { MEMHOUSE_URL: 'http://h:1', MEMHOUSE_USER: 'mira', MEMHOUSE_PASSWORD: 'invite', MEMHOUSE_DB: 'mem' });
  assert.deepStrictEqual(d, { changed: ['MEMHOUSE_PASSWORD'], values: { MEMHOUSE_PASSWORD: 'new' } });
  assert.deepStrictEqual(envfile.credentialDrift(text, { MEMHOUSE_URL: 'http://h:1', MEMHOUSE_USER: 'mira', MEMHOUSE_PASSWORD: 'new', MEMHOUSE_DB: 'mem' }).changed, [], 'in sync: nothing to adopt');
  assert.deepStrictEqual(envfile.credentialDrift('', { MEMHOUSE_PASSWORD: 'x' }).changed, [], 'no file: nothing to adopt');
  assert.deepStrictEqual(envfile.credentialDrift("MEMHOUSE_PASSWORD='p'", {}).changed, ['MEMHOUSE_PASSWORD'], 'a process with nothing adopts the file');
});

// ── a running shipper whose passes fail must not read as healthy ─────────────────────────
test('lastPass reads the shipper log: the later of success and failure wins', () => {
  const { lastPass, describeFailure } = require('../memhouse/shipper/passlog');
  const okThenFail = '[memhouse] shipped 3 sessions (0 skipped) → 40 msg rows, 2 tool rows in 1.2s\n[memhouse] pass failed: mira: Authentication failed: password is incorrect\n[memhouse] retrying in 16s\n';
  const f = lastPass(okThenFail);
  assert.strictEqual(f.outcome, 'failed'); assert.ok(f.auth); assert.match(describeFailure(f), /memhouse stop && memhouse start/);
  const failThenOk = '[memhouse] pass failed: x\n[memhouse] shipped 170 sessions (0 skipped) → 22448 msg rows, 16245 tool rows in 19.0s\n';
  assert.deepStrictEqual(lastPass(failThenOk), { outcome: 'ok', sessions: 170, rows: 22448 });
  assert.strictEqual(describeFailure(lastPass(failThenOk)), null);
  assert.deepStrictEqual(lastPass(''), { outcome: null }); assert.strictEqual(describeFailure(lastPass('')), null);
  const other = lastPass('[memhouse] pass failed: fetch failed\n'); assert.strictEqual(other.auth, false); assert.match(describeFailure(other), /memhouse doctor/);
});

// ── a folded subagent turn knows which subagent it came from ─────────────────────────────
test('claude adapter: folded subagent turns carry the agent id, description, type and turn', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-sub-')); const proj = path.join(root, 'projects', '-x'); fs.mkdirSync(proj, { recursive: true });
  const sid = '11111111-1111-1111-1111-111111111111'; const aid = 'a4485f448a3dffa16';
  const parent = [
    { type: 'user', uuid: 'u1', sessionId: sid, timestamp: '2026-09-15T10:00:00Z', cwd: '/x', message: { role: 'user', content: 'analyze the PRs' } },
    { type: 'assistant', uuid: 'a1', sessionId: sid, timestamp: '2026-09-15T10:00:05Z', cwd: '/x', message: { role: 'assistant', model: 'm', content: [ { type: 'text', text: 'spawning' }, { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Analyze 26.7 feature PRs', subagent_type: 'general-purpose', prompt: 'You are analyzing' } } ], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'user', uuid: 'u2', sessionId: sid, timestamp: '2026-09-15T10:00:09Z', cwd: '/x', message: { role: 'user', content: [ { type: 'tool_result', tool_use_id: 'toolu_1', content: `Async agent launched successfully. agentId: ${aid} (internal ID)` } ] } },
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), parent.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const sub = path.join(proj, sid, 'subagents'); fs.mkdirSync(sub, { recursive: true });
  const agentLines = [
    { type: 'user', uuid: 's1', sessionId: sid, agentId: aid, isSidechain: true, timestamp: '2026-09-15T10:00:06Z', cwd: '/x', message: { role: 'user', content: 'You are analyzing' } },
    { type: 'assistant', uuid: 's2', sessionId: sid, agentId: aid, isSidechain: true, timestamp: '2026-09-15T10:00:07Z', cwd: '/x', message: { role: 'assistant', model: 'm', content: [ { type: 'text', text: 'found three PRs' } ], usage: { input_tokens: 2, output_tokens: 2 } } },
  ];
  fs.writeFileSync(path.join(sub, `agent-${aid}.jsonl`), agentLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const claude = require('../editors/claude');
  const msgs = claude.getMessages({ _fullPath: path.join(proj, `${sid}.jsonl`) });
  const own = msgs.filter((m) => !m._agent); const folded = msgs.filter((m) => m._agent);
  assert.strictEqual(own.length, 2, 'parent turns are unmarked (a tool_result-only user line has no text and is not a turn)');
  assert.strictEqual(folded.length, 2, 'both subagent turns folded');
  assert.ok(folded.every((m) => m.content.startsWith('[subagent] ')), 'the text tag is unchanged (line_hash stability)');
  assert.deepStrictEqual(folded.map((m) => m._agent.turn), [0, 1], 'turn counts within the subagent');
  assert.strictEqual(folded[0]._agent.id, aid); assert.strictEqual(folded[0]._agent.description, 'Analyze 26.7 feature PRs'); assert.strictEqual(folded[0]._agent.type, 'general-purpose');
  const names = claude.subagentNames(path.join(proj, `${sid}.jsonl`)); assert.deepStrictEqual([...names.keys()], [aid], 'agentId joined to the Agent tool call through tool_use_id');
  // the other way a parent names a fork: the async task notification
  const bid = 'b9b9b9b9b9b9b9b9b';
  fs.appendFileSync(path.join(proj, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', uuid: 'a2', sessionId: sid, timestamp: '2026-09-15T10:01:00Z', cwd: '/x', message: { role: 'assistant', model: 'm', content: [ { type: 'tool_use', id: 'toolu_2', name: 'Agent', input: { description: 'Drill: member joins', subagent_type: 'general-purpose', prompt: 'x' } } ], usage: {} } }) + '\n'
    + JSON.stringify({ type: 'user', uuid: 'u3', sessionId: sid, timestamp: '2026-09-15T10:02:00Z', cwd: '/x', message: { role: 'user', content: `<task-notification>\n<task-id>${bid}</task-id>\n<tool-use-id>toolu_2</tool-use-id>\n<status>completed</status>\n</task-notification>` } }) + '\n');
  const names2 = claude.subagentNames(path.join(proj, `${sid}.jsonl`));
  assert.strictEqual(names2.get(bid) && names2.get(bid).description, 'Drill: member joins', 'a fork named only by its task notification is still named');
  // Workflow-run agents live one level deeper and were never folded before
  const wf = path.join(sub, 'workflows', 'wf_1234abcd-9f0'); fs.mkdirSync(wf, { recursive: true }); const wid = 'c0c0c0c0c0c0c0c0c';
  fs.writeFileSync(path.join(wf, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'v2:x', agentId: wid }) + '\n');
  fs.writeFileSync(path.join(wf, `agent-${wid}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: '1' }));
  fs.writeFileSync(path.join(wf, `agent-${wid}.jsonl`), [
    { type: 'user', uuid: 'w1', sessionId: sid, agentId: wid, isSidechain: true, timestamp: '2026-09-15T10:03:00Z', cwd: '/x', message: { role: 'user', content: 'Decompose the paperless-ngx setup into steps' } },
    { type: 'assistant', uuid: 'w2', sessionId: sid, agentId: wid, isSidechain: true, timestamp: '2026-09-15T10:03:05Z', cwd: '/x', message: { role: 'assistant', model: 'm', content: [ { type: 'text', text: 'three steps' } ], usage: {} } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const all = claude.getMessages({ _fullPath: path.join(proj, `${sid}.jsonl`) });
  const wfTurns = all.filter((m) => m._agent && m._agent.workflow);
  assert.strictEqual(wfTurns.length, 2, 'the workflow agent is folded');
  assert.strictEqual(wfTurns[0]._agent.workflow, 'wf_1234abcd-9f0'); assert.strictEqual(wfTurns[0]._agent.type, 'workflow-subagent');
  assert.strictEqual(wfTurns[0]._agent.description, 'Decompose the paperless-ngx setup into steps', 'an unnamed fork is described by its own first prompt');
  assert.deepStrictEqual(claude.subagentFiles(sub).map((x) => x.workflow), [null, 'wf_1234abcd-9f0'], 'journal and meta files are not transcripts');
  fs.rmSync(root, { recursive: true });
});

// ── a session with subagents grows tail-only, like any other ─────────────────────────────
// The defect: subagent rows were numbered by their position after the parent's turns, so
// one new parent turn moved every one of them, decideEpoch forked the session, and it
// re-shipped whole on every pass. Each growth case below must keep the epoch and send
// exactly the new rows — including a new subagent whose FILE NAME sorts before the others.
test('a session with subagents keeps its epoch and ships only new rows as it grows', () => {
  const os = require('os');
  const { rowsForChat, decideEpoch, tailRows, SUBAGENT_SEQ_BASE, SUBAGENT_SEQ_STRIDE } = require('../memhouse/shipper/ship');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-seq-')); const proj = path.join(root, 'projects', '-x'); fs.mkdirSync(proj, { recursive: true });
  const sid = '22222222-2222-2222-2222-222222222222'; const file = path.join(proj, `${sid}.jsonl`);
  const sub = path.join(proj, sid, 'subagents'); fs.mkdirSync(sub, { recursive: true });
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const tick = () => new Date(clock += 1000).toISOString();
  const user = (text) => JSON.stringify({ type: 'user', sessionId: sid, timestamp: tick(), cwd: '/x', message: { role: 'user', content: text } }) + '\n';
  const asst = (text, tool) => JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: tick(), cwd: '/x', message: { role: 'assistant', model: 'm', content: [ { type: 'text', text }, ...(tool ? [ { type: 'tool_use', id: `toolu_${clock}`, name: tool, input: { n: clock } } ] : []) ], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n';
  const append = (f, ...lines) => fs.appendFileSync(f, lines.join(''));
  const agentFile = (id) => path.join(sub, `agent-${id}.jsonl`);
  append(file, user('p0'), asst('p1', 'Read'));
  append(agentFile('m1'), user('m1 task'), asst('m1 reply', 'Grep'));
  append(file, user('p2'));
  append(agentFile('z9'), user('z9 task'), asst('z9 reply', 'Bash'));
  const chat = { source: 'claude-code', composerId: sid, _fullPath: file, folder: '/x', createdAt: clock, lastUpdatedAt: clock };
  // The house after a pass: exactly what the previous parse wrote, keyed as the room is.
  const house = { epoch: 0, maxSeq: -1, maxIdx: -1, hashes: new Map(), tools: new Map() };
  const store = (sent) => {
    for (const r of sent.msgRows) { house.hashes.set(r.seq, String(r.line_hash)); house.maxSeq = Math.max(house.maxSeq, r.seq); }
    for (const r of sent.toolRows) { house.tools.set(r.idx, { tool_name: r.tool_name, args: r.args }); house.maxIdx = Math.max(house.maxIdx, r.idx); }
  };
  const first = rowsForChat(chat, 'h');
  // Parent first and dense; each subagent a contiguous block, in the order it started.
  assert.deepStrictEqual(first.msgRows.map((r) => r.seq), [0, 1, 2, SUBAGENT_SEQ_BASE, SUBAGENT_SEQ_BASE + 1,
    SUBAGENT_SEQ_BASE + SUBAGENT_SEQ_STRIDE, SUBAGENT_SEQ_BASE + SUBAGENT_SEQ_STRIDE + 1]);
  assert.deepStrictEqual(first.toolRows.map((r) => r.idx), [0, SUBAGENT_SEQ_BASE, SUBAGENT_SEQ_BASE + SUBAGENT_SEQ_STRIDE]);
  store(first);
  const pass = (label, grow, expectText, expectTools) => {
    grow();
    const rows = rowsForChat(chat, 'h');
    const d = decideEpoch(house, rows);
    assert.deepStrictEqual(d, { epoch: 0, reason: null }, `${label}: the session forked — ${d.reason}`);
    const sent = tailRows(house, rows);
    assert.deepStrictEqual(sent.msgRows.map((r) => r.text.split('\n')[0]), expectText, `${label}: sent more (or less) than the new rows`);
    assert.deepStrictEqual(sent.toolRows.map((r) => r.tool_name), expectTools, `${label}: tool calls`);
    store(sent);
    // What the reader sees, ORDER BY seq: parent turns first, each subagent contiguous.
    return rows.msgRows.slice().sort((a, b) => a.seq - b.seq).map((r) => r.text.split('\n')[0].replace(/^\[subagent\] /, ''));
  };
  pass('the parent gains a turn', () => append(file, asst('p3', 'Edit')), ['p3'], ['Edit']);
  pass('a running subagent gains a turn', () => append(agentFile('m1'), asst('m1 more', 'Read')), ['[subagent] m1 more'], ['Read']);
  // Named 'a0…', so it sorts FIRST by file name — the case that used to shift everything.
  const order = pass('a new subagent appears whose file sorts first', () => append(agentFile('a0'), user('a0 task'), asst('a0 reply', 'Write')),
    ['[subagent] a0 task', '[subagent] a0 reply'], ['Write']);
  assert.deepStrictEqual(order, ['p0', 'p1', 'p2', 'p3', 'm1 task', 'm1 reply', 'm1 more', 'z9 task', 'z9 reply', 'a0 task', 'a0 reply']);
  pass('and the parent grows again', () => append(file, user('p4')), ['p4'], []);
  // A stale layout (0.18.9 numbered subagents by position) forks exactly once: the stored
  // subagent rows sit at seqs the new parse does not produce.
  const old = { epoch: 4, maxSeq: 6, maxIdx: 2, hashes: new Map([[0, 'x'], [5, 'y'], [6, 'z']]), tools: new Map() };
  assert.match(decideEpoch(old, first).reason, /not in the new parse/);
  // A subagent that vanishes from disk leaves stored rows nothing overwrites: fork, never overwrite.
  fs.rmSync(agentFile('z9'));
  assert.match(decideEpoch(house, rowsForChat(chat, 'h')).reason, /2 of them not in the new parse/);
  fs.rmSync(root, { recursive: true });
});

test('a subagent that grows while its parent is quiet moves the session\'s lastUpdatedAt', () => {
  // The incremental skip compares lastUpdatedAt with the house. It used to be the parent
  // file's mtime alone, so a background agent writing after its parent went idle was
  // shipped at the parent's next write, or never.
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-mtime-')); const proj = path.join(root, 'projects', '-x'); fs.mkdirSync(proj, { recursive: true });
  const line = JSON.stringify({ type: 'user', timestamp: '2026-09-29T10:00:00Z', cwd: '/x', message: { role: 'user', content: 'hi' } }) + '\n';
  const withSubs = '33333333-3333-3333-3333-333333333333'; const plain = '44444444-4444-4444-4444-444444444444';
  for (const id of [withSubs, plain]) fs.writeFileSync(path.join(proj, `${id}.jsonl`), line);
  const sub = path.join(proj, withSubs, 'subagents'); const wf = path.join(sub, 'workflows', 'wf_1');
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-aa.jsonl'), line); fs.writeFileSync(path.join(wf, 'agent-bb.jsonl'), line);
  fs.writeFileSync(path.join(sub, 'journal.jsonl'), line); // bookkeeping, not a transcript
  const at = (f, sec) => fs.utimesSync(f, sec, sec);
  const T = 1_790_000_000;
  at(path.join(proj, `${withSubs}.jsonl`), T); at(path.join(proj, `${plain}.jsonl`), T);
  at(path.join(sub, 'agent-aa.jsonl'), T - 50); at(path.join(wf, 'agent-bb.jsonl'), T - 40); at(path.join(sub, 'journal.jsonl'), T + 900);
  const saved = process.env.MEMHOUSE_CLAUDE_ROOTS; process.env.MEMHOUSE_CLAUDE_ROOTS = root;
  const claude = require('../editors/claude');
  const last = () => Object.fromEntries(claude.getChats().map((c) => [c.composerId, c.lastUpdatedAt]));
  try {
    assert.deepStrictEqual(last(), { [withSubs]: T * 1000, [plain]: T * 1000 }, 'older subagents and bookkeeping files do not move it');
    at(path.join(sub, 'agent-aa.jsonl'), T + 60);
    assert.strictEqual(last()[withSubs], (T + 60) * 1000, 'a subagent written after the parent');
    at(path.join(wf, 'agent-bb.jsonl'), T + 120);
    assert.strictEqual(last()[withSubs], (T + 120) * 1000, 'a Workflow-run agent counts too');
    assert.strictEqual(last()[plain], T * 1000, 'a session with no directory is the parent mtime, as before');
  } finally {
    if (saved === undefined) delete process.env.MEMHOUSE_CLAUDE_ROOTS; else process.env.MEMHOUSE_CLAUDE_ROOTS = saved;
    fs.rmSync(root, { recursive: true });
  }
});

test('a parse that does not fit the subagent blocks falls back to positional numbering', () => {
  const { buildRows, SUBAGENT_SEQ_BASE, SUBAGENT_SEQ_STRIDE } = require('../memhouse/shipper/ship');
  assert.ok(SUBAGENT_SEQ_BASE + 32949 * SUBAGENT_SEQ_STRIDE - 1 <= 2 ** 32 - 1, 'the last block fits UInt32 (seq is UInt32)');
  const who = { id: 'claude-code:fit', source: 'claude-code', host: 'h', folder: '', project: '' };
  const sa = (slot, turn) => ({ role: 'user', content: '[subagent] s', _ts: 2, _agent: { id: 'a', slot, turn } });
  const msgs = [{ role: 'user', content: 'p', _ts: 1 }, sa(0, 0)];
  assert.deepStrictEqual(buildRows({}, msgs, who, true).msgRows.map((r) => r.seq), [0, SUBAGENT_SEQ_BASE]);
  // A turn past the stride, or a slot past the last block, cannot be placed: null, and
  // rowsForChat then numbers the whole parse by position — correct, merely not tail-only.
  assert.strictEqual(buildRows({}, [msgs[0], sa(0, SUBAGENT_SEQ_STRIDE)], who, true), null);
  assert.strictEqual(buildRows({}, [msgs[0], sa(32949, 0)], who, true), null);
  assert.deepStrictEqual(buildRows({}, [msgs[0], sa(32949, 0)], who, false).msgRows.map((r) => r.seq), [0, 1]);
  // An adapter that folds nothing is numbered exactly as it always was.
  const plain = [{ role: 'user', content: 'a', _ts: 1 }, { role: 'assistant', content: 'b', _ts: 2, _toolCalls: [{ name: 'X', args: {} }] }];
  assert.deepStrictEqual(buildRows({}, plain, who, true), buildRows({}, plain, who, false));
});

// ── update never crosses release lines on its own ────────────────────────────────────────
test('pickChannel: an unpinned release stays on its line when its tag has moved on', () => {
  const { pickChannel } = require('../memhouse/channel');
  const tags = { latest: '0.17.1', team: '0.18.3' };
  const moved = pickChannel({ version: '0.18.2', tags });
  assert.strictEqual(moved.channel, 'team'); assert.strictEqual(moved.target, '0.18.3');
  const zeo = pickChannel({ version: '0.17.0', tags }); assert.strictEqual(zeo.channel, 'latest'); assert.strictEqual(zeo.target, '0.17.1');
  const orphan = pickChannel({ version: '0.19.0', tags }); assert.strictEqual(orphan.channel, null); assert.match(orphan.reason, /crossing lines/);
  assert.strictEqual(pickChannel({ version: '0.18.2', tags: null }).channel, null, 'no registry: no guess');
  assert.strictEqual(pickChannel({ version: '0.18.2', pinned: 'team', tags }).channel, 'team', 'a pin still wins');
});

// ── converting a pre-one-layout house is a plan of renames and grants ────────────────────
test('convert plan: renames the five rooms in one statement, swaps the grant, carries shares and policies, drops the database last only when empty', () => {
  const convert = require('../memhouse/convert');
  const steps = convert.planMember({ member: 'polat', shares: [{ reader: 'mir' }], policies: [{ name: 'p1', table: 'messages', filter: "project = 'x'", readers: ['mir'] }] });
  const sql = steps.map((s) => s.sql);
  const ren = sql.find((q) => q.startsWith('RENAME TABLE'));
  assert.ok(ren.includes('polat.messages TO mem.polat_messages') && ren.includes('polat.house_meta TO mem.polat_meta') && ren.includes('polat.house_events TO mem.polat_events'), 'all five rooms, new names');
  assert.strictEqual((ren.match(/ TO /g) || []).length, 5, 'one atomic RENAME of five pairs');
  assert.ok(sql.some((q) => q === 'REVOKE ALL ON polat.* FROM polat'));
  assert.ok(sql.some((q) => q.startsWith('GRANT SELECT, INSERT') && q.includes('ON mem.polat_* TO polat WITH GRANT OPTION')), 'the one-layout wildcard grant');
  assert.ok(sql.some((q) => q === 'GRANT SELECT ON mem.polat_* TO mir'), 'a whole-house share follows');
  assert.ok(sql.some((q) => q.startsWith('CREATE ROW POLICY OR REPLACE p1 ON mem.polat_messages FOR SELECT USING project = \'x\' TO mir')), 'a row policy follows to the new room');
  assert.ok(sql.slice(0, 6).every((q) => q.startsWith('DROP TABLE IF EXISTS polat.session_')), 'the 0.17.1 views and stat tables go first');
  const last = steps[steps.length - 1]; assert.strictEqual(last.sql, 'DROP DATABASE IF EXISTS polat'); assert.strictEqual(last.when, 'empty');
  assert.ok(convert.render(steps).includes('-- '), 'render explains every step');
});
test('envfile.setKey replaces a key in place or appends it', () => {
  const { setKey } = require('../memhouse/envfile');
  const t = "MEMHOUSE_URL='http://h'\nMEMHOUSE_DB='polat'\n";
  assert.strictEqual(setKey(t, 'MEMHOUSE_DB', 'mem'), "MEMHOUSE_URL='http://h'\nMEMHOUSE_DB='mem'\n");
  assert.strictEqual(setKey("MEMHOUSE_URL='http://h'", 'MEMHOUSE_DB', 'mem'), "MEMHOUSE_URL='http://h'\nMEMHOUSE_DB='mem'\n");
});

// ── the same machine keeps its identity across reinstalls ────────────────────────────────
test('host fingerprint is derived from the machine, stable across a wiped home', () => {
  const host = require('../memhouse/host');
  const os2 = require('os');
  const a = fs.mkdtempSync(path.join(os2.tmpdir(), 'mh-h1-')); const b = fs.mkdtempSync(path.join(os2.tmpdir(), 'mh-h2-'));
  const first = host.identity(a); const second = host.identity(b); // two homes = a wipe and reinstall
  const raw = host.stableMachineId();
  if (raw) {
    assert.strictEqual(first.fingerprint, second.fingerprint, 'same machine, same fingerprint');
    assert.strictEqual(first.id, second.id, 'and therefore the same host id');
    assert.ok(!first.fingerprint.includes(raw) && !first.id.includes(raw.slice(0, 8)), 'the raw machine id is not recoverable from what is stored');
    assert.match(host.machineFingerprint(), /^[0-9a-f]{32}$/);
  } else {
    assert.notStrictEqual(first.fingerprint, second.fingerprint, 'no machine id available: random, and honest about it');
  }
  assert.ok(fs.existsSync(host.filePath(a)), 'host.json is still written');
  fs.rmSync(a, { recursive: true }); fs.rmSync(b, { recursive: true });
});

test('fleet: a writer silent past the cutoff is retired, not a standing warning', () => {
  const DAY = 24 * 3600 * 1000; const RETIRED = 14 * DAY;
  const fleet = [
    { writer: 'polat@a', ageMs: 3 * 60000, verdict: 'ok' },
    { writer: 'polat@b', ageMs: 4 * DAY, verdict: 'stale' },
    { writer: 'default@c', ageMs: 30 * DAY, verdict: 'legacy' },
    { writer: 'polat@d', ageMs: 31 * DAY, verdict: 'legacy' },
  ];
  const retired = fleet.filter((f) => f.ageMs !== null && f.ageMs > RETIRED);
  const live = fleet.filter((f) => !retired.includes(f));
  assert.deepStrictEqual(retired.map((f) => f.writer), ['default@c', 'polat@d'], 'both month-silent writers retire');
  assert.deepStrictEqual(live.map((f) => f.writer), ['polat@a', 'polat@b'], 'the stale-but-recent one stays visible');
  assert.strictEqual(live.filter((f) => f.verdict !== 'ok').length, 1, 'only a LIVE non-ok writer colours the headline');
  assert.ok(fleet.filter((f) => f.verdict === 'legacy').every((f) => retired.includes(f)), 'a live pre-0.10 writer would still warn — these are simply not live');
});

test('channel.behind: only a strictly newer target on your own line counts', () => {
  const { behind } = require('../memhouse/channel');
  const tags = { latest: '0.18.6', team: '0.18.6' };
  assert.deepStrictEqual(behind({ version: '0.18.5', tags }), { target: '0.18.6', channel: 'latest' });
  assert.strictEqual(behind({ version: '0.18.6', tags }), null, 'current: silent');
  assert.strictEqual(behind({ version: '0.19.0', tags }), null, 'ahead of the tag: silent, never "downgrade available"');
  assert.strictEqual(behind({ version: '0.18.5', tags: null }), null, 'registry did not answer: silent, never a false alarm');
  assert.strictEqual(behind({ version: '0.18.5-nightly.1', tags }), null, 'a build on no tag gets no automatic verdict');
  assert.deepStrictEqual(behind({ version: '0.18.5', pinned: 'team', tags }), { target: '0.18.6', channel: 'team' }, 'a pin is followed');
});

// ── a page of sessions must not build a URI the transport refuses ────────────────────────
test('getChats chunks the cost scope so the request URI stays small', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'memhouse', 'server', 'queries.js'), 'utf-8');
  const i = src.indexOf('async function getChats');
  const body = src.slice(i, src.indexOf('\nasync function', i + 10));
  assert.match(body, /COST_SCOPE_CHUNK/, 'the scope is chunked');
  const chunk = Number(/COST_SCOPE_CHUNK = (\d+)/.exec(body)[1]);
  assert.ok(chunk > 0 && chunk <= 500, `chunk ${chunk} must stay well under the ~900 ids that a tunnel refuses`);
  // ~60 bytes per id, sent twice (ids + users), plus the query itself.
  assert.ok(chunk * 60 * 2 < 40000, 'a chunk must fit a conservative proxy URI limit');
  assert.ok(!/computePerChatCosts\(f, \{\s*ids: rows\.map/.test(body), 'no unchunked call passing every row');
});

// ── an admin password never has to go on the command line (O rehearsal, finding 6) ──────
test('admin password: file, stdin, flag, env, stored — in that order, never argv-only', () => {
  const { resolveAdminPassword } = require('../memhouse/admin-secret');
  const io = (content, tty = false) => ({ readFile: () => content, stdinIsTTY: tty });
  // --admin-user given AND the environment holds the password: the env is honoured. This was
  // the bug — a flagged admin user switched every other source off.
  assert.deepStrictEqual(resolveAdminPassword({ adminUser: 'default', flags: { 'admin-user': 'default' }, env: { MEMHOUSE_ADMIN_PASSWORD: 'e' } }),
    { password: 'e', source: 'env' });
  assert.deepStrictEqual(resolveAdminPassword({ adminUser: 'default', flags: { 'admin-password-file': '/x' }, env: { MEMHOUSE_ADMIN_PASSWORD: 'e' }, io: io('f\n') }),
    { password: 'f', source: 'file' }, 'a file beats the env and loses exactly one trailing newline');
  assert.strictEqual(resolveAdminPassword({ adminUser: 'a', flags: { 'admin-password-file': '/x' }, io: io('pw  \n') }).password, 'pw  ', 'trailing spaces are part of a password');
  assert.deepStrictEqual(resolveAdminPassword({ adminUser: 'a', flags: { 'admin-password-file': '-' }, io: io('s\n') }),
    { password: 's', source: 'stdin' });
  assert.throws(() => resolveAdminPassword({ adminUser: 'a', flags: { 'admin-password-file': '-' }, io: io('s', true) }), /stdin is a terminal/);
  assert.throws(() => resolveAdminPassword({ adminUser: 'a', flags: { 'admin-password-file': '/x', 'admin-password': 'p' }, io: io('f') }), /one way/);
  assert.throws(() => resolveAdminPassword({ adminUser: 'a', flags: { 'admin-password-file': true } }), /needs a path/);
  assert.deepStrictEqual(resolveAdminPassword({ adminUser: 'a', flags: { 'admin-password': 'p' }, env: { MEMHOUSE_ADMIN_PASSWORD: 'e' } }),
    { password: 'p', source: 'flag' }, 'still accepted (with a warning) — never required');
  assert.deepStrictEqual(resolveAdminPassword({ adminUser: 'a', flags: {}, env: {}, stored: { user: 'a', password: 's' } }),
    { password: 's', source: 'stored' });
  assert.deepStrictEqual(resolveAdminPassword({ adminUser: 'b', flags: {}, env: {}, stored: { user: 'a', password: 's' } }),
    { password: undefined, source: null }, "a stored password is never paired with a DIFFERENT admin user");
});

test('no child process is given a password in its argv', () => {
  // Every spawn/exec call in the shipped code, with its options object's env removed: what
  // is left is argv, and argv is world-readable through `ps` for the life of the process.
  const roots = ['bin', 'memhouse', 'editors'].map((d) => path.join(__dirname, '..', d));
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (f.endsWith('.js')) files.push(f);
  } };
  roots.forEach(walk);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8');
    const re = /\b(spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      let depth = 0; let i = m.index + m[0].length - 1; const start = i;
      for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
      const call = src.slice(start, i + 1)
        .replace(/\benv\s*:\s*\{[^}]*\}/g, '')          // env: { ... }   — not argv
        .replace(/\benv\s*:\s*[A-Za-z_.$()]+/g, '')      // env: childEnv(cfg)
        .replace(/\/\/[^\n]*/g, '')                       // comments
        // macOS `security find-generic-password` is a COMMAND NAME — the opt-in Claude
        // subscription read (editors/claude.js) reads a secret out, it passes none in.
        .replace(/find-generic-password/g, '');
      if (/password|passwd/i.test(call)) offenders.push(`${path.relative(path.join(__dirname, '..'), f)}: ${call.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `a password reaches argv:\n  ${offenders.join('\n  ')}`);
});

test('a printed plan carries a placeholder, never a password (G23)', () => {
  const p = provision.plan({ db: 'mem', member: 'alice', placeholder: true });
  const create = p.find((s) => s.sql.startsWith('CREATE USER'));
  assert.ok(create, 'the printed plan still creates the member');
  assert.strictEqual(create.sql, `CREATE USER alice IDENTIFIED BY ${provision.PASSWORD_PLACEHOLDER}`);
  // Unquoted on purpose: run as printed, it must FAIL to parse rather than create a member
  // whose password is the placeholder text.
  assert.ok(!/IDENTIFIED BY '/.test(provision.render(p, { db: 'mem', member: 'alice' })),
    'a printed plan must not hold a quoted password literal');
});

// The code a print call evaluates, with strings understood: plain string contents are prose
// and dropped, a template literal keeps only its ${…} expressions, and a parenthesis inside
// a string does not end the call. Returns the end index and that code.
function printedCode(src, open) {
  let out = '';
  const stack = [{ m: 'code', paren: 0, brace: 0 }];
  for (let i = open; i < src.length; i++) {
    const c = src[i]; const top = stack[stack.length - 1];
    if (top.m === 'code') {
      // A string used as a property key (`flags['member-password']`) is code, not prose: keep it.
      if (c === "'" || c === '"' || c === '`') { stack.push({ m: c, keep: /[\w$\])]\s*\[\s*$/.test(out) }); out += ' '; continue; }
      if (c === '(') top.paren++;
      if (c === ')' && --top.paren === 0 && stack.length === 1) return { end: i, code: out };
      if (c === '{') top.brace++;
      if (c === '}') { if (stack.length > 1 && top.brace === 0) { stack.pop(); out += ' '; continue; } top.brace--; }
      out += c; continue;
    }
    if (c === '\\') { i++; continue; }
    if (top.keep && c !== top.m) { out += c; continue; }
    if (top.m === '`' && c === '$' && src[i + 1] === '{') { stack.push({ m: 'code', paren: 0, brace: 0 }); i++; out += ' '; continue; }
    if (c === top.m) stack.pop();
  }
  return { end: src.length, code: out };
}
const SECRET_EXPR = /\b(password|pw|memberPw|memberPassword|escPw|adminPass|adminPassword|ADMPW|next)\b|\.password\b|\[\s*(member-|admin-)?password\s*\]/;
function printedSecrets(src) {
  const offenders = [];
  const re = /(console\.(log|error|warn|info)|process\.std(out|err)\.write)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const { end, code } = printedCode(src, m.index + m[0].length - 1);
    if (SECRET_EXPR.test(code)) offenders.push(`line ${src.slice(0, m.index).split('\n').length}: ${src.slice(m.index, end + 1).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return offenders;
}

test('nothing in the CLI prints a password value (G23)', () => {
  // Static half of the guarantee; misc/invite-matrix.sh runs every install, invite and
  // passwd path against a real ClickHouse and greps their output for the real values.
  // A print call that evaluates anything holding a password, as an argument, concatenated,
  // or inside ${…}, is a leak into terminals, scrollback and agent transcripts, which
  // memhouse ships into the house.
  const offenders = printedSecrets(fs.readFileSync(path.join(__dirname, '..', 'bin', 'memhouse.js'), 'utf-8'));
  assert.deepStrictEqual(offenders, [], `a password value is printed:\n  ${offenders.join('\n  ')}`);
});

test('the print-leak guard sees every way a value reaches a print call', () => {
  const caught = (code) => printedSecrets(code).length === 1;
  assert.ok(caught('console.log(`pw: ${password}`)'), 'interpolation');
  assert.ok(caught('console.log(`pw: ${password.trim()}`)'), 'an expression inside ${}');
  assert.ok(caught("console.log('pw:', password)"), 'a bare argument');
  assert.ok(caught("console.log('pw: ' + cfg.password)"), 'concatenation and a property');
  assert.ok(caught("process.stderr.write(flags['member-password'])"), 'a flag value on stderr');
  assert.ok(caught("console.log(`failed (${e.code})`, adminPassword)"), 'a ) inside a string does not end the call');
  assert.ok(!caught("console.log('rotate the password with memhouse passwd')"), 'prose about passwords is not a leak');
  assert.ok(!caught('console.log(`password rotated for ${cfg.user}`)'), 'nor is prose beside a non-secret value');
  assert.ok(!caught("console.log({ fix: ['memhouse install --password …'] })"), 'nor is a string in an array literal');
});


test('a switch never swallows the word after it (A6, G34)', () => {
  const { parseArgv, BOOLEAN_FLAGS, COMMAND_FLAGS, GLOBAL_FLAGS } = require('../memhouse/flags');
  // `update --no-install yes` set no-install to "yes" and ran the install it was told to skip.
  assert.deepStrictEqual(parseArgv(['--no-install', 'yes']), { flags: { 'no-install': true }, positional: ['yes'] });
  // `share --revoke bob` revoked nobody: revoke = "bob", no positional.
  assert.deepStrictEqual(parseArgv(['--revoke', 'bob']), { flags: { revoke: true }, positional: ['bob'] });
  // Options that take a value still take it.
  assert.deepStrictEqual(parseArgv(['--channel', 'team', '--only', 'project=x']), { flags: { channel: 'team', only: 'project=x' }, positional: [] });
  assert.deepStrictEqual(parseArgv(['--loop', '60']).flags, { loop: '60' });
  assert.deepStrictEqual(parseArgv(['--loop']).flags, { loop: true });
  // Every switch is an option some command (or every command) actually declares.
  const declared = new Set([...GLOBAL_FLAGS, ...Object.values(COMMAND_FLAGS).flat()]);
  for (const f of BOOLEAN_FLAGS) assert.ok(declared.has(f), `--${f} is a switch no command declares`);
});

test('a fresh subagent with no timestamped line holds its session for a pass (GLM-F1)', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-glmf1-'));
  try {
    const proj = path.join(root, 'projects', '-x'); fs.mkdirSync(proj, { recursive: true });
    const sid = '22222222-2222-2222-2222-222222222222';
    const line = (o) => JSON.stringify({ sessionId: sid, cwd: '/x', ...o });
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-10-08T10:00:00Z', message: { role: 'user', content: 'go' } }),
    ].join('\n') + '\n');
    const sub = path.join(proj, sid, 'subagents'); fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-aaaa.jsonl'), line({ type: 'user', uuid: 's1', isSidechain: true, timestamp: '2026-10-08T10:00:05Z', message: { role: 'user', content: 'task a' } }) + '\n');
    const fresh = path.join(sub, 'agent-bbbb.jsonl');
    fs.writeFileSync(fresh, '');   // created, first line not written yet
    const claude = require('../editors/claude');
    const chat = { _fullPath: path.join(proj, `${sid}.jsonl`) };
    assert.match(String(claude.getMessages(chat)._defer), /agent-bbbb\.jsonl has no timestamped line yet/);
    // The shipper withholds it this pass (null = retry), and says why.
    const { rowsForChat } = require('../memhouse/shipper/ship');
    if (rowsForChat) {
      const logged = []; const orig = console.log; console.log = (m) => logged.push(String(m));
      try { assert.strictEqual(rowsForChat({ source: 'claude-code', composerId: sid, _fullPath: chat._fullPath, folder: '/x', createdAt: 1, lastUpdatedAt: 1 }, 'h'), null); }
      finally { console.log = orig; }
      assert.ok(logged.some((l) => /held for one pass/.test(l)), logged.join('\n'));
    }
    // Once it has a time it is ranked by it — even ahead of a sibling that started later.
    fs.writeFileSync(fresh, line({ type: 'user', uuid: 'b1', isSidechain: true, timestamp: '2026-10-08T10:00:03Z', message: { role: 'user', content: 'task b' } }) + '\n');
    const ok1 = claude.getMessages(chat);
    assert.strictEqual(ok1._defer, undefined);
    assert.deepStrictEqual(ok1.filter((m) => m._agent).map((m) => [m._agent.id, m._agent.slot]), [['bbbb', 0], ['aaaa', 1]]);
    // A file that never gets a timestamp stops holding the session after the grace period.
    fs.writeFileSync(fresh, '');
    const old = (Date.now() - 11 * 60 * 1000) / 1000; fs.utimesSync(fresh, old, old);
    const ok2 = claude.getMessages(chat);
    assert.strictEqual(ok2._defer, undefined, 'a stale unstamped file must not block forever');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invite sends a STORED credential only to the house it was saved for (G4)', () => {
  const { provisionTarget } = require('../memhouse/invite-target');
  const url = 'https://invitee-facing.example:8443'; const storedUrl = 'https://house.example:8443';
  // The member's own credential and an admin kept in the env file are stored: never to --url.
  for (const adminUserSource of ['member', 'file']) {
    assert.deepStrictEqual(provisionTarget({ url, storedUrl, adminUserSource }), { url: storedUrl, stored: true }, adminUserSource);
  }
  // --admin-user typed now, but its password resolved from the env file: still stored.
  assert.deepStrictEqual(provisionTarget({ url, storedUrl, adminUserSource: 'flag', passwordSource: 'stored' }), { url: storedUrl, stored: true });
  // An admin given for this command, with a password given for it, provisions where it was pointed.
  for (const passwordSource of ['env', 'file', 'stdin', 'prompt', 'flag']) {
    assert.deepStrictEqual(provisionTarget({ url, storedUrl, adminUserSource: 'flag', passwordSource }), { url, stored: false }, passwordSource);
    assert.deepStrictEqual(provisionTarget({ url, storedUrl, adminUserSource: 'env', passwordSource }), { url, stored: false }, passwordSource);
  }
  // A stored credential with no stored house to send it to is refused, never sent to --url.
  assert.ok(provisionTarget({ url, storedUrl: null, adminUserSource: 'member' }).error);
  assert.ok(provisionTarget({ url, storedUrl: null, adminUserSource: 'flag', passwordSource: 'stored' }).error);
});

test('every skill finds the shared reference where the plugin installs it (G26)', () => {
  // Installed as <config>/skills/mem/{reference/HOUSE.md, skills/<name>/SKILL.md} — the same
  // shape as memhouse/delivery/plugin/, which plugins install copies verbatim.
  const root = path.join(__dirname, '..', 'memhouse', 'delivery', 'plugin');
  const skills = fs.readdirSync(path.join(root, 'skills')).filter((n) => fs.existsSync(path.join(root, 'skills', n, 'SKILL.md')));
  assert.ok(skills.length >= 5, 'the five skills');
  for (const n of skills) {
    const dir = path.join(root, 'skills', n);
    const refs = [...fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8').matchAll(/`((?:\.\.\/)+reference\/[A-Za-z]+\.md)`/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${n} points at the reference`);
    for (const r of refs) assert.ok(fs.existsSync(path.join(dir, r)), `${n}: ${r} does not resolve from skills/${n}/`);
  }
});

test('stats refresh when stale even if nothing shipped; readers re-resolve their rooms (G11)', () => {
  const h = require('../memhouse/house/house');
  const H = h.STATS_MAX_AGE_MS;
  assert.strictEqual(h.statsNeedRefresh({ shipped: 3, ageMs: 0 }), true, 'a pass that shipped refreshes, as before');
  assert.strictEqual(h.statsNeedRefresh({ shipped: 0, ageMs: H - 1 }), false, 'a fresh generation is left alone');
  assert.strictEqual(h.statsNeedRefresh({ shipped: 0, ageMs: H + 1 }), true, 'an old one is refreshed though nothing shipped');
  assert.strictEqual(h.statsNeedRefresh({ shipped: 0, ageMs: Infinity }), true, 'an emptied table (TTL) is refilled');
  assert.strictEqual(h.statsNeedRefresh({ shipped: 0, ageMs: null }), false, 'unreadable: do not refresh on every idle pass');
  assert.ok(H < 24 * 3600 * 1000, 'the age limit must undercut the one-day TTL, or the dashboard empties first');
  const now = 1_000_000_000;
  assert.strictEqual(h.roomsCacheStale(0, now), true, 'never resolved');
  assert.strictEqual(h.roomsCacheStale(now - 1000, now), false, 'just resolved');
  assert.strictEqual(h.roomsCacheStale(now - h.ROOMS_TTL_MS - 1, now), true, 'resolved too long ago');
  // The dashboard's cache must use it — a process-lifetime cache is the bug.
  const q = fs.readFileSync(path.join(__dirname, '..', 'memhouse', 'server', 'queries.js'), 'utf-8');
  assert.match(q, /roomsCacheStale\(roomsAt\)/, 'queries.js rooms() must re-resolve when stale');
  const ship = fs.readFileSync(path.join(__dirname, '..', 'memhouse', 'shipper', 'ship.js'), 'utf-8');
  assert.ok(!/if \(sessions > 0\) await refreshStats/.test(ship), 'refresh must not be gated on shipping alone');
  // …and the one call site that refreshes after a pass must ask statsNeedRefresh.
  const site = ship.slice(ship.indexOf('for (const table of Object.keys(batches)) await flush(table);'));
  assert.match(site.slice(0, 600), /if \(statsNeedRefresh\(\{ shipped: sessions,[^]*?\)\) \{\s*await refreshStats\(client, rooms\);/,
    'the end-of-pass refresh must be decided by statsNeedRefresh');
});

if (process.exitCode) console.error(`\n${passed} passed, some failed`);
else console.log(`${passed}/${passed} unit checks pass`);
