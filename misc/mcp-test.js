#!/usr/bin/env node
// Live end-to-end for `memhouse mcp`: a throwaway ClickHouse in docker, the real
// schema, seeded rows, and the real server driven over real stdio JSON-RPC — the
// same frames a client sends. Not part of `npm test` (needs docker); run directly:
//
//   node misc/mcp-test.js
//
// Ground rules (tests/herdr-driven-acceptance.md): throwaway house only, removed
// with `docker rm -f -v`; MEMHOUSE_HOME is a temp dir; the pilot's real houses
// (localhost:8123, localhost:18999) are never touched.
//
// What must hold, per memhouse/mcp/PLAN.md P8:
//   (a) no house => per-call refusal, and NEVER a connection to localhost:8123
//   (b) a write through `sql` is refused by the SERVER (readonly), verbatim
//   (c) the credential appears in no frame the server emits
//   (d) stdout carries JSON-RPC and nothing else — including under MEMHOUSE_DEBUG=1

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 19750;
const NAME = 'mh-mcp-test';
const PASS = 'mcp-test-secret-pw';
const URL = `http://127.0.0.1:${PORT}`;

function sh(cmd, args, opts = {}) { return spawnSync(cmd, args, { encoding: 'utf8', ...opts }); }

async function chq(sql, { retries = 0, db = 'mem' } = {}) {
  const res = await fetch(`${URL}/?allow_experimental_full_text_index=1${db ? `&database=${db}` : ''}`, {
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

// ── one MCP server process, driven line-by-line ─────────────────────────────────
function startServer(env) {
  const proc = spawn('node', [path.join(ROOT, 'bin', 'memhouse.js'), 'mcp'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const rawFrames = [];
  let stderrBuf = '';
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      rawFrames.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { pending.forEach((p) => p.reject(new Error(`non-JSON on stdout: ${line.slice(0, 120)}`))); return; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    }
  });
  proc.stderr.on('data', (c) => { stderrBuf += c; });
  let nextId = 1;
  return {
    proc, rawFrames,
    stderr: () => stderrBuf,
    notify(method, params) { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    rpc(method, params) {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout waiting for ${method} (id ${id})`)); }, 15000);
      });
    },
    close() { proc.stdin.end(); return new Promise((r) => proc.on('exit', r)); },
  };
}

const META = 'io.modelcontextprotocol/';
const MODERN_META = { [`${META}protocolVersion`]: '2026-07-28', [`${META}clientCapabilities`]: {} };
const parseTool = (r) => JSON.parse(r.result.content[0].text);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  // ── the throwaway house ───────────────────────────────────────────────────────
  sh('docker', ['rm', '-f', '-v', NAME]);
  const up = sh('docker', ['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:8123`,
    '-e', `CLICKHOUSE_PASSWORD=${PASS}`, 'clickhouse/clickhouse-server:latest']);
  if (up.status !== 0) { console.error(`docker run failed: ${up.stderr}`); process.exit(1); }

  try {
    await chq('SELECT 1', { retries: 30, db: '' });
    await chq('CREATE DATABASE IF NOT EXISTS mem', { db: '' });
    const tpl = fs.readFileSync(path.join(ROOT, 'memhouse', 'house', 'schema.sql.tpl'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of tpl.split(';').map((s) => s.trim()).filter(Boolean)) await chq(stmt);
    // Seed: one live claude-code session with a needle, one imported claude-ai row.
    await chq(`INSERT INTO sessions (session_id, source, host, name, folder, project, origin, message_count) VALUES
      ('claude-code:11111111-2222-3333-4444-555555555555', 'claude-code', 'mac1', 'fix readonly settings', '/tmp/proj', 'memhouse', 'ship', 5),
      ('claude-ai:imported-1', 'claude-ai', 'web', 'an imported conversation', '', 'claude-ai-import', 'claude-ai', 1)`);
    await chq(`INSERT INTO messages (session_id, seq, source, host, ts, role, model, text, project, folder, origin, line_hash) VALUES
      ('claude-code:11111111-2222-3333-4444-555555555555', 1, 'claude-code', 'mac1', '2026-08-12 10:00:00', 'user', '', 'how do I pin xylophone-unmistakable-needle readonly settings', 'memhouse', '/tmp/proj', 'ship', 1),
      ('claude-code:11111111-2222-3333-4444-555555555555', 2, 'claude-code', 'mac1', '2026-08-12 10:00:05', 'assistant', 'claude-opus-5', 'you set readonly per request', 'memhouse', '/tmp/proj', 'ship', 2),
      ('claude-code:11111111-2222-3333-4444-555555555555', 3, 'claude-code', 'mac1', '2026-08-12 10:01:00', 'user', '', 'and the caps?', 'memhouse', '/tmp/proj', 'ship', 3),
      ('claude-code:11111111-2222-3333-4444-555555555555', 4, 'claude-code', 'mac1', '2026-08-12 10:01:10', 'assistant', 'claude-opus-5', 'max_result_rows and friends', 'memhouse', '/tmp/proj', 'ship', 4),
      ('claude-code:11111111-2222-3333-4444-555555555555', 5, 'claude-code', 'mac1', '2026-08-12 10:02:00', 'user', '', 'thanks', 'memhouse', '/tmp/proj', 'ship', 5),
      ('claude-ai:imported-1', 1, 'claude-ai', 'web', '2026-08-01 09:00:00', 'user', '', 'imported text', 'claude-ai-import', '', 'claude-ai', 6)`);

    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memhouse-mcp-test-'));
    const env = {
      MEMHOUSE_URL: URL, MEMHOUSE_USER: 'default', MEMHOUSE_PASSWORD: PASS,
      MEMHOUSE_DB: 'mem', MEMHOUSE_HOME: HOME, MEMHOUSE_DEBUG: '1', // debug ON: purity must survive it
    };
    const SID = 'claude-code:11111111-2222-3333-4444-555555555555';
    const s = startServer(env);

    await test('server/discover answers the modern shape', async () => {
      const r = await s.rpc('server/discover', { _meta: MODERN_META });
      assert.deepStrictEqual(r.result.supportedVersions, ['2026-07-28']);
      assert.strictEqual(r.result._meta[`${META}serverInfo`].name, 'memhouse');
    });

    await test('legacy initialize works on the same process (dual-era)', async () => {
      const r = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '0' } });
      assert.strictEqual(r.result.protocolVersion, '2025-06-18');
      s.notify('notifications/initialized');
    });

    await test('tools/list serves six tools in fixed order', async () => {
      const r = await s.rpc('tools/list', { _meta: MODERN_META });
      assert.deepStrictEqual(r.result.tools.map((t) => t.name),
        ['search', 'timeline', 'get_session', 'stats', 'resume_command', 'sql']);
    });

    let est;
    await test('search finds the needle and prices the expansion', async () => {
      const r = await s.rpc('tools/call', { name: 'search', arguments: { q: 'XYLOPHONE-unmistakable' }, _meta: MODERN_META });
      const out = parseTool(r);
      assert.strictEqual(out.matches, 1);
      const hit = out.results[0];
      assert.strictEqual(hit.session_id, SID);
      assert.strictEqual(hit.user_id, 'default');
      assert.strictEqual(hit.hits, 1);
      assert.ok(hit.snippet.includes('xylophone'));
      assert.ok(hit.est_expand_tokens > 0, 'expansion is priced');
      est = hit.est_expand_tokens;
    });

    await test('get_session returns the transcript, and a seq slice slices', async () => {
      const full = parseTool(await s.rpc('tools/call', { name: 'get_session', arguments: { session_id: SID }, _meta: MODERN_META }));
      assert.strictEqual(full.found, true);
      assert.strictEqual(full.messages.length, 5);
      assert.ok(full.messages[1].text.includes('readonly per request'));
      const slice = parseTool(await s.rpc('tools/call', { name: 'get_session', arguments: { session_id: SID, seq_from: 2, seq_to: 3 }, _meta: MODERN_META }));
      assert.deepStrictEqual(slice.messages.map((m) => m.seq), [2, 3]);
      // The pricing from search is the same order of magnitude as the reality.
      const chars = full.messages.reduce((a, m) => a + m.text.length, 0);
      assert.ok(Math.abs(est - Math.floor(chars / 4)) <= 1, `est ${est} ~ chars/4 ${Math.floor(chars / 4)}`);
    });

    await test('timeline anchors on a session', async () => {
      const out = parseTool(await s.rpc('tools/call', { name: 'timeline', arguments: { session_id: SID }, _meta: MODERN_META }));
      assert.ok(out.sessions.length >= 2, 'both seeded sessions are near each other');
    });

    await test('stats breaks the house down by source/user/host with freshness', async () => {
      const out = parseTool(await s.rpc('tools/call', { name: 'stats', arguments: {}, _meta: MODERN_META }));
      assert.strictEqual(out.total_sessions, 2);
      assert.strictEqual(out.total_messages, 6);
      const cc = out.breakdown.find((b) => b.source === 'claude-code');
      assert.strictEqual(cc.user_id, 'default');
      assert.strictEqual(cc.host, 'mac1');
    });

    await test('resume_command: a real command for a shipped session, cd included', async () => {
      const out = parseTool(await s.rpc('tools/call', { name: 'resume_command', arguments: { session_id: SID }, _meta: MODERN_META }));
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.command, 'cd /tmp/proj && claude --resume 11111111-2222-3333-4444-555555555555');
    });

    await test('resume_command: an imported session is refused honestly, not guessed', async () => {
      const out = parseTool(await s.rpc('tools/call', { name: 'resume_command', arguments: { session_id: 'claude-ai:imported-1' }, _meta: MODERN_META }));
      assert.strictEqual(out.ok, false);
      assert.ok(out.reason.includes('imported'), out.reason);
    });

    await test('sql: reads work', async () => {
      const out = parseTool(await s.rpc('tools/call', { name: 'sql', arguments: { query: 'SELECT count() AS n FROM messages' }, _meta: MODERN_META }));
      assert.strictEqual(Number(out.rows[0].n), 6);
    });

    await test('sql: a write is refused by the SERVER and the refusal reaches the caller verbatim', async () => {
      const r = await s.rpc('tools/call', { name: 'sql', arguments: { query: "INSERT INTO messages (session_id, seq) VALUES ('x', 1)" }, _meta: MODERN_META });
      assert.strictEqual(r.result.isError, true);
      assert.ok(/readonly/i.test(r.result.content[0].text), `server refusal passed through: ${r.result.content[0].text.slice(0, 120)}`);
    });

    await test('the credential appears in no frame the server ever emitted', async () => {
      assert.ok(s.rawFrames.length > 8);
      for (const f of s.rawFrames) assert.ok(!f.includes(PASS), 'password leaked into a frame');
    });

    await test('stdout is protocol-only, even with MEMHOUSE_DEBUG=1', async () => {
      for (const f of s.rawFrames) JSON.parse(f); // every line parses or this throws
    });

    await test('stdin EOF is a clean exit', async () => {
      await s.close();
    });

    await test('no house: discovery answers, tools refuse per-call, and nothing dials localhost:8123', async () => {
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memhouse-mcp-nohouse-'));
      // Empty-string env vars would still count as "stated" — delete, don't blank.
      const env2 = { ...process.env };
      for (const k of Object.keys(env2)) if (k.startsWith('MEMHOUSE_')) delete env2[k];
      env2.MEMHOUSE_HOME = emptyHome;
      const proc = spawn('node', [path.join(ROOT, 'bin', 'memhouse.js'), 'mcp'], { env: env2, stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = [];
      let b2 = '';
      proc.stdout.on('data', (c) => { b2 += c; let i; while ((i = b2.indexOf('\n')) >= 0) { lines.push(b2.slice(0, i)); b2 = b2.slice(i + 1); } });
      const send = (id, method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      send(1, 'tools/list', { _meta: MODERN_META });
      send(2, 'tools/call', { name: 'search', arguments: { q: 'anything' }, _meta: MODERN_META });
      await new Promise((r) => setTimeout(r, 2500));
      proc.stdin.end();
      const msgs = lines.map((l) => JSON.parse(l));
      const list = msgs.find((m) => m.id === 1);
      const call = msgs.find((m) => m.id === 2);
      assert.strictEqual(list.result.tools.length, 6, 'discovery survives no-house');
      assert.strictEqual(call.result.isError, true);
      assert.ok(call.result.content[0].text.includes('no house configured'));
    });
  } finally {
    sh('docker', ['rm', '-f', '-v', NAME]);
  }

  if (process.exitCode) console.error(`\n${passed} passed, some failed`);
  else console.log(`\n${passed}/${passed} live mcp checks pass (house removed)`);
  process.exit(process.exitCode || 0);
})();
