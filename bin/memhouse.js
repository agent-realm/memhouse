#!/usr/bin/env node
// memhouse — the mem-house CLI. One command to install, ship, serve, and query
// agent conversation memory (see mem-house/DESIGN.md).
//
// Thin orchestrator: heavy operations run the existing entrypoints
// (mem-house/shipper/ship.js, mem-house/server/server.js) as children with the
// resolved MEMHOUSE_* env, so there is a single source of truth for shipping and
// serving. The CLI owns: config (~/.memhouse/env), daemons (pidfiles), probes,
// and the small read-only queries (status/search) done over ClickHouse HTTP.
//
// Every command is dual-mode: interactive for humans, flag/env-driven (--yes,
// --json where relevant) for agents. Config precedence: flags > process env >
// $MEMHOUSE_HOME/env file > defaults.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SHIP_JS = path.join(REPO_ROOT, 'mem-house', 'shipper', 'ship.js');
const SERVER_JS = path.join(REPO_ROOT, 'mem-house', 'server', 'server.js');
const DELIVERY = path.join(REPO_ROOT, 'mem-house', 'delivery');
const PKG = require(path.join(REPO_ROOT, 'package.json'));

const HOME_DIR = process.env.MEMHOUSE_HOME || path.join(os.homedir(), '.memhouse');
const ENV_FILE = path.join(HOME_DIR, 'env');
const RUN_DIR = path.join(HOME_DIR, 'run');
const LOG_DIR = path.join(HOME_DIR, 'logs');

// ── args ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
const rest = cmd ? argv.slice(1) : argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}
const JSON_OUT = flags.json === true;

// ── config ──────────────────────────────────────────────────────────────────────
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) {
        let v = m[2].trim();
        // Unwrap shell quoting (we write single-quoted; tolerate double too).
        if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
          v = v.slice(1, -1).replace(/'\\''/g, "'");
        } else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
          v = v.slice(1, -1);
        }
        out[m[1]] = v;
      }
    }
  } catch { /* no env file yet */ }
  return out;
}

function resolveConfig() {
  const file = readEnvFile();
  const pick = (flag, env, dflt) => flags[flag] !== undefined && flags[flag] !== true
    ? flags[flag] : (process.env[env] ?? file[env] ?? dflt);
  return {
    url: pick('url', 'MEMHOUSE_URL', 'http://localhost:8123'),
    user: pick('user', 'MEMHOUSE_USER', 'memhouse_root'),
    password: pick('password', 'MEMHOUSE_PASSWORD', ''),
    db: pick('db', 'MEMHOUSE_DB', 'memhouse'),
    port: pick('port', 'MEMHOUSE_PORT', '4640'),
  };
}

function childEnv(cfg) {
  return {
    ...process.env,
    MEMHOUSE_URL: cfg.url, MEMHOUSE_USER: cfg.user, MEMHOUSE_PASSWORD: cfg.password,
    MEMHOUSE_DB: cfg.db, MEMHOUSE_PORT: String(cfg.port), MEMHOUSE_HOME: HOME_DIR,
  };
}

function writeEnvFile(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  // Single-quoted values: this file is also sourced by shells (skills/docs use
  // `. ~/.memhouse/env`), so metacharacters in a password must never be bare.
  const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const body = [
    '# mem-house connection — written by `memhouse install/setup`',
    `MEMHOUSE_URL=${sq(cfg.url)}`,
    `MEMHOUSE_USER=${sq(cfg.user)}`,
    `MEMHOUSE_PASSWORD=${sq(cfg.password)}`,
    `MEMHOUSE_DB=${sq(cfg.db)}`,
    `MEMHOUSE_PORT=${sq(cfg.port)}`,
    '',
  ].join('\n');
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
}

// ── ClickHouse over HTTP (small read-only queries; heavy ops go via ship.js) ───
async function ch(cfg, sql, { database = cfg.db } = {}) {
  const params = new URLSearchParams({ final: '1' });
  if (database) params.set('database', database);
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/?${params}`, {
    method: 'POST',
    body: sql,
    headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64') },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split('\n')[0]);
  return text.trim();
}
async function chRows(cfg, sql, opts) {
  const text = await ch(cfg, sql + ' FORMAT JSONEachRow', opts);
  return text ? text.split('\n').map((l) => JSON.parse(l)) : [];
}

// ── small helpers ───────────────────────────────────────────────────────────────
const ok = (s) => `  \x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `  \x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `  \x1b[33m•\x1b[0m ${s}`;

function run(script, args, cfg, { inherit = true } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    env: childEnv(cfg), stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf-8',
  });
  return r.status ?? 1;
}

async function ask(question, dflt) {
  const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(dflt !== undefined ? `${question} [${dflt}]: ` : `${question}: `)).trim();
  rl.close();
  return a || dflt || '';
}

function pidOf(name) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(RUN_DIR, name + '.pid'), 'utf-8'), 10);
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

function ensureUiBuilt() {
  if (fs.existsSync(path.join(REPO_ROOT, 'public', 'index.html'))) return true;
  const uiDir = path.join(REPO_ROOT, 'ui');
  if (!fs.existsSync(uiDir)) return false;
  console.log('  building dashboard UI (first run, ~1-2 min)…');
  for (const args of [['install', '--no-audit', '--no-fund'], ['run', 'build']]) {
    const r = spawnSync('npm', args, { cwd: uiDir, stdio: 'pipe' });
    if (r.status !== 0) { console.log(bad('UI build failed — dashboard will 503; run: cd ui && npm install && npm run build')); return false; }
  }
  return true;
}

// ── commands ────────────────────────────────────────────────────────────────────
const HELP = `
memhouse ${PKG.version} — agent conversation memory across 17 editors

Setup        onboard              interactive wizard: discover → configure → ship → start
             install              scriptable setup (--url --user --password --db [--yes] [--no-ship])
             setup                (re)write the connection config only (--yes = no prompts)
             discover             read-only preflight: editors, sessions, reachable ClickHouses
             uninstall            stop daemons + remove ${HOME_DIR.replace(os.homedir(), '~')} (house data untouched)
             reset                truncate the house tables and re-ship everything (--yes to skip confirm)

Data         ship                 one incremental pass (--full | --loop [sec])
             stats                per-source session/message/token counts
             search <terms…>      full-text search across all sessions
             start | stop |       shipper loop + dashboard as background daemons
             status               daemons, connection, counts, freshness (--json)
             doctor               diagnose the whole pipeline

Agents       plugins              list | install claude [--target DIR] | remove claude
             prompt               print the memory system-prompt snippet

Config: flags > MEMHOUSE_* env > ${ENV_FILE.replace(os.homedir(), '~')} > defaults.
`;

// A skipped adapter and an editor the user does not have look identical — both
// contribute zero sessions. Say which happened, and how to fix the one that is fixable.
function printAdapterErrors(errors) {
  if (!errors || errors.length === 0) return;
  const blocked = errors.filter((e) => e.missingBinding);
  const other = errors.filter((e) => !e.missingBinding);
  if (blocked.length) {
    console.log(warn(`${blocked.length} adapter${blocked.length > 1 ? 's' : ''} skipped — better-sqlite3 has no native binding: ${blocked.map((e) => e.source).join(', ')}`));
    console.log('  their sessions are NOT being shipped. npm >= 12 blocks install scripts by default; rebuild with:');
    console.log('    npm install -g memhouse --allow-scripts=better-sqlite3');
    console.log('  (from a checkout: npm install --no-audit --no-fund, which package.json already allows)');
  }
  for (const e of other) console.log(warn(`${e.source.padEnd(16)} skipped: ${e.message}`));
}

async function cmdDiscover() {
  const out = { editors: [], clickhouse: [], config: null, memoryHouse: false };
  process.stdout.write(JSON_OUT ? '' : 'Scanning editors (reading local session stores)…\n');
  try {
    const { getAllChats, getAdapterErrors } = require(path.join(REPO_ROOT, 'editors'));
    const counts = {};
    for (const c of getAllChats()) counts[c.source] = (counts[c.source] || 0) + 1;
    out.editors = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([source, sessions]) => ({ source, sessions }));
    out.adapterErrors = getAdapterErrors();
  } catch (e) { out.editorsError = e.message; }

  for (const url of [...new Set([resolveConfig().url, 'http://localhost:8123'])]) {
    const probe = { url, reachable: false };
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/ping', { signal: AbortSignal.timeout(3000) });
      probe.reachable = res.ok;
      if (res.ok) {
        try {
          const cfg = { ...resolveConfig(), url };
          probe.version = await ch(cfg, 'SELECT version()', { database: '' });
          const dbs = (await chRows(cfg, 'SELECT name FROM system.databases', { database: '' })).map((r) => r.name);
          probe.hasHouse = dbs.includes(cfg.db);
          probe.kernel = dbs.includes('sys');
        } catch { probe.auth = 'needed'; }
      }
    } catch { /* unreachable */ }
    out.clickhouse.push(probe);
  }
  out.config = fs.existsSync(ENV_FILE) ? ENV_FILE : null;
  out.memoryHouse = fs.existsSync(path.join(os.homedir(), '.config', 'memory-house'));

  if (JSON_OUT) return console.log(JSON.stringify(out, null, 2));
  console.log('\nEditors with sessions on this machine:');
  if (out.editors.length === 0) console.log(warn('none found' + (out.editorsError ? ` (${out.editorsError})` : '')));
  for (const e of out.editors) console.log(ok(`${e.source.padEnd(16)} ${e.sessions} sessions`));
  printAdapterErrors(out.adapterErrors);
  console.log('\nClickHouse endpoints:');
  for (const p of out.clickhouse) {
    if (!p.reachable) console.log(bad(`${p.url} — unreachable`));
    else if (p.auth) console.log(warn(`${p.url} — reachable, credentials needed`));
    else console.log(ok(`${p.url} — v${p.version}${p.hasHouse ? ', house present' : ''}${p.kernel ? ', KERNEL detected' : ''}`));
  }
  console.log('');
  console.log(out.config ? ok(`config: ${out.config}`) : warn('no config yet — run: memhouse install (or onboard)'));
  if (out.memoryHouse) console.log(warn('memory-house detected on this machine (they coexist fine)'));
}

async function cmdInstall({ interactive }) {
  let cfg = resolveConfig();
  const haveAll = flags.yes === true || (flags.url && flags.user !== undefined);
  if (interactive || !haveAll) {
    console.log('mem-house connection (Enter keeps the default):');
    cfg.url = await ask('  ClickHouse URL', cfg.url);
    cfg.user = await ask('  user', cfg.user);
    cfg.password = await ask('  password', cfg.password);
    cfg.db = await ask('  database (the house)', cfg.db);
    cfg.port = await ask('  dashboard port', cfg.port);
  }
  if (!/^[A-Za-z0-9_]{1,64}$/.test(cfg.db)) {
    console.log(bad(`invalid database name '${cfg.db}' — use letters, digits, underscore`));
    return 1;
  }
  writeEnvFile(cfg);
  console.log(ok(`config written: ${ENV_FILE}`));
  // Preflight WITHOUT selecting the house — on a fresh standalone ClickHouse the
  // database doesn't exist yet, and selecting it would fail before we can create it.
  try { await ch(cfg, 'SELECT 1', { database: '' }); }
  catch (e) { console.log(bad(`connection failed: ${e.message}`)); console.log('  fix the connection, then re-run: memhouse install'); return 1; }
  console.log(ok('connection verified'));
  // Ensure the house exists (standalone path). On a kernel realm the house is
  // provisioned by install-agency and this is a no-op; if the user lacks CREATE
  // DATABASE but the house is already reachable, that's fine too.
  try { await ch(cfg, `CREATE DATABASE IF NOT EXISTS ${cfg.db}`, { database: '' }); }
  catch (e) {
    try { await ch(cfg, 'SELECT 1'); }
    catch { console.log(bad(`house '${cfg.db}' does not exist and cannot be created: ${e.message}`)); return 1; }
  }
  console.log(ok(`house '${cfg.db}' ready`));
  if (run(SHIP_JS, ['--ensure-schema'], cfg) !== 0) return 1;
  if (flags['no-ship'] !== true) {
    if (run(SHIP_JS, [], cfg) !== 0) return 1;
  }
  console.log(ok('installed — next: memhouse start   (dashboard + shipper loop)'));
  return 0;
}

async function cmdOnboard() {
  console.log(`memhouse ${PKG.version} — onboarding\n`);
  await cmdDiscover();
  console.log('');
  const code = await cmdInstall({ interactive: true });
  if (code !== 0) return code;
  const yn = (await ask('Start the daemons now? (Y/n)', 'Y')).toLowerCase();
  if (yn !== 'n' && yn !== 'no') await cmdStart();
  return 0;
}

async function cmdStart() {
  const cfg = resolveConfig();
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  ensureUiBuilt();
  const daemons = [
    { name: 'shipper', script: SHIP_JS, args: ['--loop', String(flags.interval || 300)] },
    { name: 'dashboard', script: SERVER_JS, args: [] },
  ];
  for (const d of daemons) {
    if (pidOf(d.name)) { console.log(warn(`${d.name} already running (pid ${pidOf(d.name)})`)); continue; }
    const log = fs.openSync(path.join(LOG_DIR, d.name + '.log'), 'a');
    const child = spawn(process.execPath, [d.script, ...d.args], {
      env: childEnv(cfg), detached: true, stdio: ['ignore', log, log],
    });
    fs.writeFileSync(path.join(RUN_DIR, d.name + '.pid'), String(child.pid));
    child.unref();
    console.log(ok(`${d.name} started (pid ${child.pid})`));
  }
  console.log(`  dashboard → http://localhost:${cfg.port}`);
}

function cmdStop() {
  let stopped = 0;
  for (const name of ['shipper', 'dashboard']) {
    const pid = pidOf(name);
    if (pid) { try { process.kill(pid, 'SIGTERM'); console.log(ok(`${name} stopped (pid ${pid})`)); stopped++; } catch { /* raced */ } }
    try { fs.unlinkSync(path.join(RUN_DIR, name + '.pid')); } catch { /* absent */ }
  }
  if (!stopped) console.log(warn('nothing was running'));
}

async function cmdStatus() {
  const cfg = resolveConfig();
  const out = {
    config: fs.existsSync(ENV_FILE) ? ENV_FILE : null,
    url: cfg.url, db: cfg.db, user: cfg.user,
    daemons: { shipper: pidOf('shipper'), dashboard: pidOf('dashboard') },
    connected: false,
  };
  try {
    out.connected = true && !!(await ch(cfg, 'SELECT 1'));
    const s = await chRows(cfg, 'SELECT count() AS sessions FROM sessions_v');
    const m = await chRows(cfg, "SELECT count() AS msgs, formatDateTime(max(ingested_at), '%Y-%m-%d %H:%i:%S') AS freshest FROM messages");
    out.sessions = Number(s[0]?.sessions || 0);
    out.messages = Number(m[0]?.msgs || 0);
    out.freshest = m[0]?.freshest || null;
  } catch (e) { out.connected = false; out.error = e.message; }

  if (JSON_OUT) return console.log(JSON.stringify(out, null, 2));
  console.log(out.config ? ok(`config: ${out.config}`) : warn('no config (memhouse install)'));
  console.log(out.connected ? ok(`connected: ${cfg.url} / ${cfg.db} as ${cfg.user}`) : bad(`not connected: ${out.error || cfg.url}`));
  if (out.connected) console.log(ok(`house: ${out.sessions} sessions, ${out.messages} messages (freshest ingest ${out.freshest} UTC)`));
  for (const [name, pid] of Object.entries(out.daemons)) {
    console.log(pid ? ok(`${name}: running (pid ${pid})`) : warn(`${name}: not running`));
  }
  if (out.daemons.dashboard) console.log(`  dashboard → http://localhost:${cfg.port}`);
}

async function cmdDoctor() {
  const cfg = resolveConfig();
  const checks = [];
  const add = (okFlag, label, hint) => checks.push({ ok: okFlag, label, hint });

  const [major, minor] = process.versions.node.split('.').map(Number);
  add(major > 20 || (major === 20 && minor >= 19), `node ${process.versions.node}`, 'need >= 20.19');
  add(fs.existsSync(ENV_FILE), `config ${ENV_FILE}`, 'run: memhouse install');
  try { await ch(cfg, 'SELECT 1', { database: '' }); add(true, `clickhouse reachable (${cfg.url})`); }
  catch (e) { add(false, `clickhouse reachable (${cfg.url})`, e.message); }
  try {
    const t = (await chRows(cfg, "SELECT name FROM system.tables WHERE database = {db:String} AND name IN ('sessions','messages','tool_calls')".replace('{db:String}', `'${cfg.db}'`), { database: '' })).length;
    add(t === 3, `schema: ${t}/3 tables in '${cfg.db}'`, 'run: memhouse install (ensure-schema)');
  } catch (e) { add(false, 'schema check', e.message); }
  try {
    const u = await chRows(cfg, 'SELECT any(user_id) AS u FROM sessions');
    add((u[0]?.u ?? '') !== '' || (await chRows(cfg, 'SELECT count() AS c FROM sessions'))[0].c === 0,
      `identity stamping (user_id='${u[0]?.u ?? ''}')`, 'writers must use async_insert=0');
  } catch { add(false, 'identity stamping', 'schema missing?'); }
  let adapterErrors = [];
  try {
    const { getAllChats, getAdapterErrors, getMessages } = require(path.join(REPO_ROOT, 'editors'));
    const chats = getAllChats();
    const seen = chats.length;
    // Listing sessions is not the same as being able to read them. Goose, for one,
    // can query `sessions` while its `messages` rows use a schema this parser cannot
    // decode — the shipper would then withhold every one of those sessions while
    // doctor reported a clean bill of health. Read the newest session per source so
    // the message readers actually run; that is one parse per editor, not a full scan.
    // One chat per source is not enough coverage: several adapters mix storage
    // paths, and a probe only exercises the one the sampled chat happens to use.
    // Each such adapter declares which store a chat came from — Cursor as _type
    // (agent-store vs workspace), Goose as _storage (sqlite vs jsonl), OpenCode as
    // _storageType (file vs sqlite) — so probing one chat per declared variant
    // covers every path deterministically.
    //
    // The newest/middle/oldest spread is kept on top of that as a cheap hedge for
    // any split an adapter does NOT declare.
    const picks = new Map();
    const bySource = new Map();
    for (const chat of chats) {
      if (!bySource.has(chat.source)) bySource.set(chat.source, []);
      bySource.get(chat.source).push(chat);
    }
    for (const [source, list] of bySource) {
      for (const i of new Set([0, Math.floor(list.length / 2), list.length - 1])) {
        picks.set(`${source}#${i}`, list[i]);
      }
      for (const chat of list) {
        const variant = `${source}|${chat._type || ''}|${chat._storage || ''}|${chat._storageType || ''}`;
        if (!picks.has(variant)) picks.set(variant, chat);
      }
    }

    const thrown = [];
    for (const chat of picks.values()) {
      // Not every reader reports through the sink — some throw instead, e.g.
      // Cursor's agent-store path, where discovery reads `meta` fine but
      // collectStoreMessages() can throw on a corrupt `blobs` table. Swallowing
      // that here would discard the only signal and leave doctor green while the
      // shipper withholds every one of those sessions.
      try { getMessages(chat); }
      catch (e) { thrown.push({ source: chat.source, message: ((e && e.message) || String(e)).split('\n')[0] }); }
    }
    adapterErrors = getAdapterErrors();
    for (const t of thrown) {
      if (!adapterErrors.some((e) => e.source === t.source)) adapterErrors.push({ ...t, missingBinding: false });
    }
    // Any adapter that could not be read is a failure, whatever the cause — a
    // locked or corrupt store loses just as many sessions as a missing binding.
    const blocked = adapterErrors.filter((e) => e.missingBinding).map((e) => e.source);
    const failed = adapterErrors.map((e) => e.source);
    add(adapterErrors.length === 0,
      `adapters: ${seen} sessions visible locally${failed.length ? ` (${failed.length} skipped: ${failed.join(', ')})` : ''}`,
      blocked.length ? 'npm install -g memhouse --allow-scripts=better-sqlite3'
        : adapterErrors.length ? adapterErrors.map((e) => `${e.source}: ${e.message}`).join('; ')
          : undefined);
  } catch (e) { add(false, 'adapters', e.message); }
  add(!!pidOf('shipper'), 'shipper daemon', 'memhouse start');
  add(!!pidOf('dashboard'), 'dashboard daemon', 'memhouse start');
  add(fs.existsSync(path.join(REPO_ROOT, 'public', 'index.html')), 'dashboard UI built', 'built automatically by memhouse start');

  for (const c of checks) console.log(c.ok ? ok(c.label) : bad(`${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function cmdSearch() {
  if (!positional.length) { console.log('usage: memhouse search <terms…>'); return 2; }
  const cfg = resolveConfig();
  const needle = positional.join(' ').toLowerCase().replace(/[%_\\]/g, '\\$&').replace(/'/g, "\\'");
  const rows = await chRows(cfg, `
    SELECT session_id, any(source) AS source, any(project) AS project,
           formatDateTime(max(ts), '%Y-%m-%d %H:%i') AS at, count() AS hits,
           substring(any(text), 1, 150) AS snippet
    FROM messages
    WHERE text_ngram LIKE '%${needle}%'
    GROUP BY session_id ORDER BY max(ts) DESC LIMIT ${Number(flags.limit) || 10}`);
  if (JSON_OUT) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(warn('no matches'));
  for (const r of rows) {
    console.log(`\x1b[1m${r.session_id.slice(0, 8)}\x1b[0m  ${r.source}  ${r.project || '-'}  ${r.at}  (${r.hits} hits)`);
    console.log(`  ${r.snippet.replace(/\s+/g, ' ')}`);
  }
}

function cmdPlugins() {
  const sub = positional[0] || 'list';
  const target = flags.target || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const skillsSrc = path.join(DELIVERY, 'skills');
  const names = fs.readdirSync(skillsSrc);
  const dstSkills = path.join(target, 'skills');
  if (sub === 'list') {
    console.log(`skills available: ${names.join(', ')}`);
    for (const n of names) {
      console.log(fs.existsSync(path.join(dstSkills, n)) ? ok(`${n} installed in ${dstSkills}`) : warn(`${n} not installed (memhouse plugins install claude)`));
    }
  } else if (sub === 'install' && positional[1] === 'claude') {
    fs.mkdirSync(dstSkills, { recursive: true });
    for (const n of names) fs.cpSync(path.join(skillsSrc, n), path.join(dstSkills, n), { recursive: true });
    console.log(ok(`installed ${names.length} skills into ${dstSkills} (${names.join(', ')})`));
  } else if (sub === 'remove' && positional[1] === 'claude') {
    let removed = 0;
    for (const n of names) { const p = path.join(dstSkills, n); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true }); removed++; } }
    console.log(ok(`removed ${removed} skills from ${dstSkills}`));
  } else {
    console.log('usage: memhouse plugins [list | install claude | remove claude] [--target DIR]');
    return 2;
  }
  return 0;
}

async function cmdReset() {
  const cfg = resolveConfig();
  if (flags.yes !== true) {
    const a = (await ask(`This truncates ALL rows in '${cfg.db}' and re-ships. Continue? (yes/no)`, 'no')).toLowerCase();
    if (a !== 'yes' && a !== 'y') return console.log('aborted'), 1;
  }
  for (const t of ['sessions', 'messages', 'tool_calls']) await ch(cfg, `TRUNCATE TABLE IF EXISTS ${t}`);
  console.log(ok('house truncated'));
  return run(SHIP_JS, ['--full'], cfg);
}

function cmdUninstall() {
  cmdStop();
  if (fs.existsSync(HOME_DIR)) fs.rmSync(HOME_DIR, { recursive: true });
  console.log(ok(`removed ${HOME_DIR} (the house data in ClickHouse is untouched)`));
}

// ── dispatch ────────────────────────────────────────────────────────────────────
(async () => {
  const cfg = resolveConfig();
  switch (cmd) {
    case null: case 'help': console.log(HELP); break;
    case 'version': console.log(PKG.version); break;
    case 'discover': await cmdDiscover(); break;
    case 'onboard': process.exitCode = await cmdOnboard(); break;
    case 'install': process.exitCode = await cmdInstall({ interactive: false }); break;
    case 'setup': {
      // Dual-mode like install: --yes (with any --url/--user/--password/--db/
      // --port overrides, already resolved into cfg) skips every prompt so
      // agents/CI can rewrite the config non-interactively.
      const c = { ...cfg };
      if (flags.yes !== true) {
        c.url = await ask('  ClickHouse URL', c.url);
        c.user = await ask('  user', c.user);
        c.password = await ask('  password', c.password);
        c.db = await ask('  database (the house)', c.db);
        c.port = await ask('  dashboard port', c.port);
      }
      if (!/^[A-Za-z0-9_]{1,64}$/.test(c.db)) {
        console.log(bad(`invalid database name '${c.db}' — use letters, digits, underscore`));
        process.exitCode = 1;
        break;
      }
      writeEnvFile(c);
      console.log(ok(`config written: ${ENV_FILE}`));
      break;
    }
    case 'ship': {
      const args = [];
      if (flags.full === true) args.push('--full');
      if (flags.loop !== undefined) { args.push('--loop'); if (flags.loop !== true) args.push(String(flags.loop)); }
      process.exitCode = run(SHIP_JS, args, cfg);
      break;
    }
    case 'stats': process.exitCode = run(SHIP_JS, ['--stats'], cfg); break;
    case 'start': await cmdStart(); break;
    case 'stop': cmdStop(); break;
    case 'status': await cmdStatus(); break;
    case 'doctor': process.exitCode = await cmdDoctor(); break;
    case 'search': process.exitCode = await cmdSearch(); break;
    case 'plugins': process.exitCode = cmdPlugins(); break;
    case 'prompt': process.stdout.write(fs.readFileSync(path.join(DELIVERY, 'PROMPT.md'), 'utf-8')); break;
    case 'reset': process.exitCode = await cmdReset(); break;
    case 'deploy': {
      // The missing first mile: stand up a ClickHouse, then install into it.
      if (!flags.local && !flags.down) { console.log(bad('usage: memhouse deploy --local | --down')); process.exitCode = 2; break; }
      const compose = path.join(REPO_ROOT, 'deploy', 'compose.yml');
      if (!fs.existsSync(compose)) { console.log(bad(`compose file missing: ${compose}`)); process.exitCode = 1; break; }
      if (flags.down) {
        // compose demands MEMHOUSE_PASSWORD for every subcommand, teardown included.
        // Any value works — the server is never contacted.
        const d = spawnSync('docker', ['compose', '-f', compose, 'down', '-v'],
          { env: { ...process.env, MEMHOUSE_PASSWORD: process.env.MEMHOUSE_PASSWORD || 'teardown' }, stdio: 'inherit' });
        console.log(d.status === 0 ? ok('local ClickHouse removed (volume included)') : bad('teardown failed'));
        process.exitCode = d.status === 0 ? 0 : 1;
        break;
      }
      const pw = process.env.MEMHOUSE_PASSWORD || crypto.randomBytes(16).toString('hex');
      const port = String(flags.port || process.env.MEMHOUSE_PORT || 8123);
      const env = { ...process.env, MEMHOUSE_PASSWORD: pw, MEMHOUSE_PORT: port };
      const up = spawnSync('docker', ['compose', '-f', compose, 'up', '-d'], { env, stdio: 'inherit' });
      if (up.status !== 0) { console.log(bad('docker compose up failed — is Docker running?')); process.exitCode = 1; break; }
      // Wait for the healthcheck rather than guessing: an install against a
      // still-starting server fails in a way that looks like a bad credential.
      const url = `http://localhost:${port}`;
      let live = false;
      for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { live = true; break; } } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!live) { console.log(bad(`ClickHouse did not answer on ${url} — check: docker logs memhouse-clickhouse`)); process.exitCode = 1; break; }
      console.log(ok(`ClickHouse up on ${url} (loopback only)`));
      process.env.MEMHOUSE_URL = url;
      process.env.MEMHOUSE_USER = 'memhouse_root';
      process.env.MEMHOUSE_PASSWORD = pw;
      process.env.MEMHOUSE_DB = process.env.MEMHOUSE_DB || 'memhouse';
      flags.url = url; flags.user = 'memhouse_root'; flags.password = pw; flags.db = process.env.MEMHOUSE_DB;
      flags.yes = true;
      process.exitCode = await cmdInstall({ interactive: false });
      break;
    }
    case 'service': {
      const svc = require(path.join(REPO_ROOT, 'mem-house', 'service.js'));
      const sub = positional[0] || 'status';
      if (sub === 'install') {
        const r = svc.install({ shipJs: SHIP_JS, envFile: ENV_FILE, logDir: LOG_DIR, interval: flags.interval || 300 });
        if (!r.ok) { console.log(bad(r.msg)); process.exitCode = 1; break; }
        console.log(ok(`service installed (${r.kind}): ${r.path}`));
        console.log('  survives reboot; `memhouse start` is no longer needed');
        if (r.warn) console.log(warn(r.warn));
      } else if (sub === 'uninstall') {
        const r = svc.uninstall();
        console.log(r.ok ? ok(`service removed (${r.kind})`) : bad(r.msg));
      } else {
        const st = svc.status();
        if (!st.kind) { console.log(warn(`no service integration for '${process.platform}'`)); break; }
        console.log(st.installed ? ok(`service installed (${st.kind}): ${st.path}`) : warn('service not installed'));
        console.log(st.running ? ok('service running') : warn('service not running'));
      }
      break;
    }
    case 'uninstall': cmdUninstall(); break;
    default:
      console.error(`unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 2;
  }
})().catch((e) => { console.error(bad(e.message)); process.exit(1); });
