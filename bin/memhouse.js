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
const SOLO_JS = path.join(REPO_ROOT, 'mem-house', 'solo', 'server.js');
const DELIVERY = path.join(REPO_ROOT, 'mem-house', 'delivery');
const PKG = require(path.join(REPO_ROOT, 'package.json'));
const { roomNames, ROOM_TYPES } = require(path.join(REPO_ROOT, 'mem-house', 'per-member', 'rooms'));
const envfile = require(path.join(REPO_ROOT, 'mem-house', 'envfile'));

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
  try { return envfile.parse(fs.readFileSync(ENV_FILE, 'utf-8')); } catch { return {}; }
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
    // Which room layout this house uses. It has to be part of the persisted config, not a
    // variable that happens to be exported in one shell: the shipper, the dashboard, the
    // CLI's own queries and the installed OS service must all agree, or one of them reads
    // (or writes) the wrong rooms.
    perMember: (flags['per-member'] === true ? '1' : null)
      ?? process.env.MEM_PER_MEMBER ?? file.MEM_PER_MEMBER ?? '0',
    // Which tier this house is, persisted for the same reason as the layout: the shim IS
    // the house on the solo tier, and `start` has to know to bring it up. Inferring it
    // from the runtime pidfile fails exactly once — after `memhouse stop`, which removes
    // the pidfile — and the next `start` silently points the shipper and dashboard at a
    // dead port.
    solo: process.env.MEMHOUSE_SOLO ?? file.MEMHOUSE_SOLO ?? '0',
    soloPort: process.env.MEMHOUSE_SOLO_PORT ?? file.MEMHOUSE_SOLO_PORT ?? '',
  };
}

function childEnv(cfg) {
  return {
    ...process.env,
    MEMHOUSE_URL: cfg.url, MEMHOUSE_USER: cfg.user, MEMHOUSE_PASSWORD: cfg.password,
    MEMHOUSE_DB: cfg.db, MEMHOUSE_PORT: String(cfg.port), MEMHOUSE_HOME: HOME_DIR,
    MEM_PER_MEMBER: String(cfg.perMember || '0'),
    MEMHOUSE_SOLO: String(cfg.solo || '0'),
    ...(cfg.soloPort ? { MEMHOUSE_SOLO_PORT: String(cfg.soloPort) } : {}),
  };
}

function writeEnvFile(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  // Single-quoted values: this file is also sourced by shells (skills/docs use
  // `. ~/.memhouse/env`), so metacharacters in a password must never be bare.
  const sq = envfile.quoteShell;
  const body = [
    '# mem-house connection — written by `memhouse install/setup`',
    `MEMHOUSE_URL=${sq(cfg.url)}`,
    `MEMHOUSE_USER=${sq(cfg.user)}`,
    `MEMHOUSE_PASSWORD=${sq(cfg.password)}`,
    `MEMHOUSE_DB=${sq(cfg.db)}`,
    `MEMHOUSE_PORT=${sq(cfg.port)}`,
    `MEM_PER_MEMBER=${sq(cfg.perMember || '0')}`,
    `MEMHOUSE_SOLO=${sq(cfg.solo || '0')}`,
    ...(cfg.soloPort ? [`MEMHOUSE_SOLO_PORT=${sq(cfg.soloPort)}`] : []),
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

/** Port from a configured URL, '' when it has none or the URL is unparseable. */
function portOf(u) {
  try { return new URL(u).port || ''; } catch { return ''; }
}

// Is whatever answers this URL our own solo shim, or some other ClickHouse? Both answer
// /ping with `Ok.`, so the tier cannot be told from readiness alone. The shim sets a
// display name on every response; a server sets its own.
async function isSoloShim(url) {
  try {
    const r = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(3000) });
    return r.headers.get('x-clickhouse-server-display-name') === 'memhouse-solo';
  } catch { return false; }
}

// Is the shipper alive, by whichever mechanism owns it? After `service install` the
// pidfile is deliberately gone — the service took over — so a pidfile-only check reports
// "not running" for every correctly service-managed install, and `doctor` fails on a
// healthy machine. Returns { running, via }.
function shipperHealth() {
  const pid = pidOf('shipper');
  if (pid) return { running: true, via: `daemon (pid ${pid})` };
  try {
    const svc = require(path.join(REPO_ROOT, 'mem-house', 'service.js'));
    const st = svc.status();
    if (st.installed) return { running: st.running, via: `service (${st.kind})` };
  } catch { /* no service integration on this platform */ }
  return { running: false, via: null };
}

// Room routing for the CLI's own queries. The shipper and dashboard resolve rooms through
// @clickhouse/client; the CLI speaks raw HTTP, so it asks the same question over its own
// transport and builds the names with the same shared function.
let _rooms = null;
async function roomsFor(cfg) {
  if (_rooms) return _rooms;
  if (String(cfg.perMember || '0') !== '1') { _rooms = roomNames(null); return _rooms; }
  const rows = await chRows(cfg, 'SELECT currentUser() AS u');
  const member = rows[0] && rows[0].u;
  if (!member) throw new Error('could not determine currentUser() for per-member room resolution');
  _rooms = roomNames(member);
  return _rooms;
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

House        deploy --local       run ClickHouse in docker/podman, then install
             deploy --solo        embedded chdb behind a local shim — one user, no server
             deploy --down        remove the local house (container + volume)
                                  [--house-port N] [--tag 25.11]  (--port is the dashboard)
             service install      run the shipper as a user service (systemd / launchd)
             service uninstall | status

Config: flags > MEMHOUSE_* env > ${ENV_FILE.replace(os.homedir(), '~')} > defaults.
Layout: --per-member (or MEM_PER_MEMBER=1) uses one set of rooms per member; persisted.
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
  // Rooms. In the shared layout the installer creates them; in the per-member layout the
  // OWNER mints them and the member cannot (nor should) run the shared schema — so here
  // the step is a check, not a creation, and it names the command that fixes it.
  if (String(cfg.perMember) === '1') {
    const r = await roomsFor(cfg);
    const want = ROOM_TYPES.map((t) => r[t]).concat(r.sessions_v);
    let present = [];
    try {
      const list = `'${want.join("','")}'`;
      present = (await chRows(cfg, `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN (${list})`, { database: '' })).map((x) => x.name);
    } catch (e) { console.log(bad(`could not list rooms: ${e.message}`)); return 1; }
    const missing = want.filter((n) => !present.includes(n));
    if (missing.length) {
      console.log(bad(`per-member layout: '${r.member}' has no ${missing.join(', ')} in '${cfg.db}'`));
      console.log('  rooms are minted by the house owner, not by install. Ask them to run:');
      console.log(`    node mem-house/per-member/provision.js --member ${r.member}`);
      return 1;
    }
    console.log(ok(`rooms present for '${r.member}': ${want.join(', ')}`));
  } else if (run(SHIP_JS, ['--ensure-schema'], cfg) !== 0) return 1;
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
    // The solo shim IS the house — start it first, or the shipper has nothing to talk to.
    // Read from the persisted config, never from the pidfile: `stop` removes the pidfile,
    // so a pidfile test would drop the shim on the first stop/start cycle.
    ...(String(cfg.solo) === '1' ? [{ name: 'solo', script: SOLO_JS, args: [] }] : []),
    { name: 'shipper', script: SHIP_JS, args: ['--loop', String(flags.interval || 300)] },
    { name: 'dashboard', script: SERVER_JS, args: [] },
  ];
  // Anything an installed service owns must not also be started here. Those pidfiles are
  // deliberately absent — `service install` removed them when it took over — so the
  // "already running?" check below cannot see the service's processes at all.
  //
  // For the shipper that means two loops parsing and clearing the same sessions
  // concurrently, each deleting rows the other just inserted. For the solo shim it is
  // quieter and just as wrong: the second one dies on EADDRINUSE, the readiness probe
  // passes because the SERVICE's shim answers, and `start` reports success while leaving
  // a pidfile pointing at a process that is already dead.
  //
  // Reachable in the obvious way: after a reboot the user wants the dashboard back, which
  // is not service-managed, and types `memhouse start`.
  let svcStatus = { installed: false, running: false, solo: { installed: false, running: false } };
  try { svcStatus = require(path.join(REPO_ROOT, 'mem-house', 'service.js')).status(); } catch { /* unsupported platform */ }
  const owned = [
    ...(svcStatus.installed ? [['shipper', svcStatus.running, 'memhouse-shipper']] : []),
    ...(svcStatus.solo?.installed ? [['solo', svcStatus.solo.running, 'memhouse-solo']] : []),
  ];
  for (const [name, running, unit] of owned) {
    const i = daemons.findIndex((d) => d.name === name);
    if (i >= 0) daemons.splice(i, 1);
    console.log(warn(`${name} is service-managed (${svcStatus.kind}${running ? '' : ', not running'}) — not starting a second one`));
    if (!running) {
      console.log(svcStatus.kind === 'systemd'
        ? `  start it with: systemctl --user start ${unit}`
        : `  start it with: launchctl kickstart gui/$(id -u)/com.${unit.replace('memhouse-', 'memhouse.')}`);
    }
  }
  // The house still has to be up before the dashboard is worth starting, whoever owns the
  // shim. When we spawn it the gate is inside the loop below; when the service owns it,
  // this is the only place it gets checked.
  if (String(cfg.solo) === '1' && !daemons.some((d) => d.name === 'solo')) {
    const dep = require(path.join(REPO_ROOT, 'mem-house', 'deploy.js'));
    if (!(await dep.waitReady(cfg.url, { attempts: 20, delayMs: 500 }))) {
      console.log(bad(`solo house not answering on ${cfg.url} — the service owns it; check: journalctl --user -u memhouse-solo`));
      process.exitCode = 1;
      return;
    }
    console.log(ok(`solo house answering on ${cfg.url} (service-managed)`));
  }
  for (const d of daemons) {
    if (pidOf(d.name)) { console.log(warn(`${d.name} already running (pid ${pidOf(d.name)})`)); continue; }
    const log = fs.openSync(path.join(LOG_DIR, d.name + '.log'), 'a');
    const child = spawn(process.execPath, [d.script, ...d.args], {
      env: childEnv(cfg), detached: true, stdio: ['ignore', log, log],
    });
    fs.writeFileSync(path.join(RUN_DIR, d.name + '.pid'), String(child.pid));
    child.unref();
    console.log(ok(`${d.name} started (pid ${child.pid})`));
    // Spawn order is not readiness. chdb takes a moment to open its data directory, and
    // if the shipper's first request loses that race it does not retry promptly — it
    // catches the connection error and sleeps the whole loop interval, so the first ship
    // is up to five minutes late for no reason. Wait for the house, as deploy does.
    if (d.name === 'solo') {
      const dep = require(path.join(REPO_ROOT, 'mem-house', 'deploy.js'));
      const ready = await dep.waitReady(cfg.url, { attempts: 40, delayMs: 500 });
      console.log(ready ? ok(`solo house answering on ${cfg.url}`)
        : bad(`solo house not answering on ${cfg.url} — see ${path.join(LOG_DIR, 'solo.log')}`));
      // Nonzero, or automation reads "started fine" from a run that started nothing:
      // neither shipper nor dashboard is spawned past this point.
      if (!ready) { process.exitCode = 1; return; }
    }
  }
  console.log(`  dashboard → http://localhost:${cfg.port}`);
}

function cmdStop() {
  let stopped = 0;
  for (const name of ['shipper', 'dashboard', 'solo']) {
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
    shipper: shipperHealth(),
    connected: false,
  };
  try {
    out.connected = true && !!(await ch(cfg, 'SELECT 1'));
    const r = await roomsFor(cfg);
    if (r.perMember) out.member = r.member;
    const s = await chRows(cfg, `SELECT count() AS sessions FROM ${r.sessions_v}`);
    const m = await chRows(cfg, `SELECT count() AS msgs, formatDateTime(max(ingested_at), '%Y-%m-%d %H:%i:%S') AS freshest FROM ${r.messages}`);
    out.sessions = Number(s[0]?.sessions || 0);
    out.messages = Number(m[0]?.msgs || 0);
    out.freshest = m[0]?.freshest || null;
  } catch (e) { out.connected = false; out.error = e.message; }

  if (JSON_OUT) return console.log(JSON.stringify(out, null, 2));
  console.log(out.config ? ok(`config: ${out.config}`) : warn('no config (memhouse install)'));
  console.log(out.connected ? ok(`connected: ${cfg.url} / ${cfg.db} as ${cfg.user}`) : bad(`not connected: ${out.error || cfg.url}`));
  if (out.member) console.log(ok(`layout: per-member rooms for '${out.member}'`));
  if (out.connected) console.log(ok(`house: ${out.sessions} sessions, ${out.messages} messages (freshest ingest ${out.freshest} UTC)`));
  console.log(out.shipper.running ? ok(`shipper: running — ${out.shipper.via}`) : warn('shipper: not running'));
  console.log(out.daemons.dashboard ? ok(`dashboard: running (pid ${out.daemons.dashboard})`) : warn('dashboard: not running'));
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
  let rooms = roomNames(null);
  try { rooms = await roomsFor(cfg); } catch (e) { add(false, 'room resolution', e.message); }
  if (rooms.perMember) add(true, `layout: per-member rooms for '${rooms.member}'`);
  try {
    // The ROLLUP VIEW counts. Every product read path goes through it — dashboard,
    // status, search, stats — so a house with three healthy rooms and no view ships fine
    // and fails every read with UNKNOWN_TABLE, while a rooms-only check calls that a
    // clean bill of health.
    const objects = [...ROOM_TYPES.map((t) => rooms[t]), rooms.sessions_v];
    const want = objects.map((n) => `'${n}'`).join(',');
    const t = (await chRows(cfg, `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN (${want})`, { database: '' })).length;
    add(t === objects.length, `schema: ${t}/${objects.length} rooms+view in '${cfg.db}' (${objects.join(', ')})`,
      rooms.perMember ? `run, as the owner: node mem-house/per-member/provision.js --member ${rooms.member}` : 'run: memhouse install (ensure-schema)');
  } catch (e) { add(false, 'schema check', e.message); }
  try {
    const u = await chRows(cfg, `SELECT any(user_id) AS u FROM ${rooms.sessions}`);
    add((u[0]?.u ?? '') !== '' || (await chRows(cfg, `SELECT count() AS c FROM ${rooms.sessions}`))[0].c === 0,
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
  const sh = shipperHealth();
  add(sh.running, `shipper${sh.via ? ` — ${sh.via}` : ''}`, 'memhouse start (or: memhouse service install)');
  add(!!pidOf('dashboard'), 'dashboard daemon', 'memhouse start');
  add(fs.existsSync(path.join(REPO_ROOT, 'public', 'index.html')), 'dashboard UI built', 'built automatically by memhouse start');

  for (const c of checks) console.log(c.ok ? ok(c.label) : bad(`${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function cmdSearch() {
  if (!positional.length) { console.log('usage: memhouse search <terms…>'); return 2; }
  const cfg = resolveConfig();
  const needle = positional.join(' ').toLowerCase().replace(/[%_\\]/g, '\\$&').replace(/'/g, "\\'");
  const r = await roomsFor(cfg);
  const rows = await chRows(cfg, `
    SELECT session_id, any(source) AS source, any(project) AS project,
           formatDateTime(max(ts), '%Y-%m-%d %H:%i') AS at, count() AS hits,
           substring(any(text), 1, 150) AS snippet
    FROM ${r.messages}
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
  const r = await roomsFor(cfg);
  const targets = ROOM_TYPES.map((t) => r[t]);
  if (flags.yes !== true) {
    // Name the rooms. Under the per-member layout this only ever empties the caller's own,
    // and "ALL rows in 'mem'" would misdescribe that in the alarming direction.
    const a = (await ask(`This truncates ${targets.join(', ')} in '${cfg.db}' and re-ships. Continue? (yes/no)`, 'no')).toLowerCase();
    if (a !== 'yes' && a !== 'y') return console.log('aborted'), 1;
  }
  // DELETE, not TRUNCATE. Two reasons, and the second is the one that bites:
  //   * TRUNCATE is its own privilege, and a provisioned member holds SELECT, INSERT and
  //     the two ALTER grants — so `reset` failed with an authorization error for every
  //     normally provisioned member;
  //   * on the SHARED layout TRUNCATE is worse than unauthorized, it is wrong: the rooms
  //     hold every member's rows, and a row policy scopes reads, not TRUNCATE. One member
  //     resetting would empty the house.
  // Scoping on the caller's own user_id is correct in both layouts. The value is bound
  // rather than `currentUser()`, which a mutation does not evaluate in the caller's
  // context and which therefore matches nothing at all.
  const uid = (await chRows(cfg, 'SELECT currentUser() AS u'))[0]?.u;
  if (!uid) return console.log(bad('could not determine currentUser() — refusing to reset')), 1;
  const esc = uid.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  for (const t of targets) await ch(cfg, `DELETE FROM ${t} WHERE user_id = '${esc}'`);
  console.log(ok(`cleared ${uid}'s rows from ${targets.join(', ')}`));
  return run(SHIP_JS, ['--full'], cfg);
}

function cmdUninstall() {
  // The OS service first, and this is not tidiness: it outlives the pidfile daemons by
  // design, it holds the credential inlined in its unit file, and it restarts itself. An
  // uninstall that stopped only the daemons would report success while a service kept
  // shipping transcripts — with a credential in a file the user now believes is gone.
  const svc = require(path.join(REPO_ROOT, 'mem-house', 'service.js'));
  const st = svc.status();
  if (st.kind && (st.installed || st.solo?.installed)) {
    const r = svc.uninstall();
    if (!r.ok) {
      // Removing the home now would delete the env file while a service keeps shipping
      // with the credential inlined in its unit — and report that memhouse is gone.
      console.log(bad(`service NOT removed: ${r.msg}`));
      console.log(`  ${HOME_DIR} left in place. Re-run uninstall once the service is stopped.`);
      process.exitCode = 1;
      return;
    }
    console.log(ok(`service removed (${r.kind})`));
  }
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
      const dep = require(path.join(REPO_ROOT, 'mem-house', 'deploy.js'));
      if (flags.down) {
        const r = dep.down();
        console.log(r.ok ? ok(`local ClickHouse removed (${r.engine}${r.volumeRemoved ? ', volume included' : ''})`) : bad(r.msg));
        process.exitCode = r.ok ? 0 : 1;
        break;
      }
      // Two ports are in play and they are not the same port: the house speaks ClickHouse
      // HTTP, the dashboard serves the SPA. `--port` belongs to the dashboard everywhere
      // else in this CLI (it is persisted as MEMHOUSE_PORT), so deploy takes `--house-port`
      // and the two can never be handed the same number by accident.
      const housePort = flags['house-port'];
      if (flags.port !== undefined && housePort === undefined) {
        console.log(warn('deploy: --port is the dashboard port; use --house-port for ClickHouse'));
      }
      if (flags.solo) {
        // Single-user tier: an embedded chdb behind a local ClickHouse-HTTP shim.
        // No container, no server, no sharing — see mem-house/solo/server.js.
        //
        // The per-member layout cannot apply here and must not be half-applied: chdb has
        // no users, so currentUser() is always 'default' and the rooms would be named
        // `sessions_default` — the shape of a multi-member house with exactly one member
        // and no grants to separate anybody. Refuse rather than build that.
        if (String(resolveConfig().perMember) === '1') {
          console.log(bad('solo is a single-user tier: chdb has no users or grants, so MEM_PER_MEMBER cannot apply.'));
          console.log('  use `deploy --local` (a real ClickHouse) for the per-member layout.');
          process.exitCode = 2; break;
        }
        // The persisted port is part of the precedence chain: re-running `deploy --solo`
        // after configuring a custom port must find the existing house, not wait on 8123
        // and then silently relocate the shim (and overwrite the saved port with it).
        const port = String(housePort || process.env.MEMHOUSE_SOLO_PORT || resolveConfig().soloPort || 8123);
        fs.mkdirSync(RUN_DIR, { recursive: true }); fs.mkdirSync(LOG_DIR, { recursive: true });
        // An explicit port change while a shim is running has to move the shim. Otherwise
        // `pidOf('solo')` suppresses the spawn, the old shim stays healthy on the old
        // port, and the command waits 40s against a port nothing is listening on before
        // failing — with the house working the whole time, on the address it used to use.
        // A service-managed shim has no pidfile — `service install` removed it — so the
        // detached-process check below cannot see it. Moving the port anyway would start
        // a second house and repoint the CLI at it while the installed shipper unit kept
        // writing to the old one: two houses, and the memory silently splits between them.
        if (housePort && String(housePort) !== String(resolveConfig().soloPort || '')) {
          let svcSolo = { installed: false };
          try { svcSolo = require(path.join(REPO_ROOT, 'mem-house', 'service.js')).status().solo || { installed: false }; } catch { /* unsupported */ }
          if (svcSolo.installed) {
            console.log(bad(`the solo house is service-managed on port ${resolveConfig().soloPort || '?'} — changing its port here would leave the installed shipper writing to the old one.`));
            console.log('  memhouse service uninstall, then re-deploy on the new port, then memhouse service install');
            process.exitCode = 2; break;
          }
        }
        const runningPid = pidOf('solo');
        if (runningPid && housePort && String(housePort) !== String(resolveConfig().soloPort || '')) {
          console.log(warn(`solo house is on port ${resolveConfig().soloPort || '?'}; moving it to ${housePort}`));
          try { process.kill(runningPid, 'SIGTERM'); } catch { /* raced */ }
          try { fs.unlinkSync(path.join(RUN_DIR, 'solo.pid')); } catch { /* absent */ }
          await new Promise((r) => setTimeout(r, 500)); // let the port free before rebinding
        }
        if (!pidOf('solo')) {
          const log = fs.openSync(path.join(LOG_DIR, 'solo.log'), 'a');
          const child = spawn(process.execPath, [SOLO_JS], {
            env: { ...process.env, MEMHOUSE_SOLO_PORT: port }, detached: true, stdio: ['ignore', log, log],
          });
          fs.writeFileSync(path.join(RUN_DIR, 'solo.pid'), String(child.pid));
          child.unref();
        }
        const url = `http://127.0.0.1:${port}`;
        const dep2 = require(path.join(REPO_ROOT, 'mem-house', 'deploy.js'));
        if (!(await dep2.waitReady(url, { attempts: 40, delayMs: 1000 }))) {
          console.log(bad(`solo house did not answer on ${url} — see ${path.join(LOG_DIR, 'solo.log')}`));
          process.exitCode = 1; break;
        }
        // Answering is not the same as being OURS. A real ClickHouse on this port answers
        // /ping identically, so a shim that died on EADDRINUSE looks ready — and the
        // install below would then overwrite a working url/user/password with
        // `default` and no credential, locking the CLI out of the server that is actually
        // there. The shim stamps every response with its own display name; require it.
        if (!(await isSoloShim(url))) {
          console.log(bad(`something else is already serving ${url} — it answers /ping but is not a memhouse solo house.`));
          console.log('  if that is the local ClickHouse, stop it first:  memhouse deploy --down');
          console.log(`  or put the solo house somewhere else:  memhouse deploy --solo --house-port <n>`);
          process.exitCode = 2; break;
        }
        console.log(ok(`solo house on ${url} (embedded chdb, single user, loopback only)`));
        // Recorded in the config so `start` and `service install` know this house is a
        // shim they have to bring up, rather than a server that is simply there.
        process.env.MEMHOUSE_SOLO = '1';
        process.env.MEMHOUSE_SOLO_PORT = port;
        flags.url = url; flags.user = 'default'; flags.password = '';
        flags.db = flags.db || process.env.MEMHOUSE_DB || 'memhouse';
        flags.yes = true;
        process.exitCode = await cmdInstall({ interactive: false });
        break;
      }
      if (!flags.local) { console.log(bad('usage: memhouse deploy --local | --solo | --down')); process.exitCode = 2; break; }
      // VALIDATE FIRST, then act. Everything below that can refuse runs before anything
      // is stopped: a safety refusal that has already killed a healthy shipper and
      // dashboard is worse than the problem it is refusing, and in the missing-credential
      // case those processes may be the last things holding a usable connection.
      const priorCfg = resolveConfig();
      const initialised = dep.volumeExists();
      const reusable = initialised && priorCfg.password ? priorCfg.password : null;

      // Every way of asking for a different password against an existing house. The image
      // applies CLICKHOUSE_PASSWORD only when it INITIALISES a data directory, so any of
      // them would be written to the config and then rejected by the server — the lockout.
      // `--password` counts: it lands in priorCfg via resolveConfig, so without this it
      // would masquerade as the credential being reused.
      const rotateAsk = flags['rotate-password'] === true ? '--rotate-password'
        : (flags.password !== undefined && flags.password !== true) ? '--password'
          : process.env.MEMHOUSE_PASSWORD ? 'MEMHOUSE_PASSWORD' : null;
      if (initialised && rotateAsk) {
        console.log(bad(`${rotateAsk} cannot change the credential of an existing house — the image only applies it when it initialises the data directory.`));
        console.log('  to rotate:   ALTER USER memhouse_root IDENTIFIED BY \'…\' inside the house, then: memhouse setup --password …');
        console.log('  to start over (DESTROYS the memory):  memhouse deploy --down');
        process.exitCode = 2; break;
      }
      // An initialised volume with no credential to reuse — env file deleted, emptied, or
      // never written — is the same lockout by another route: a generated password would
      // be ignored by the server and then written over the config as if it worked.
      if (initialised && !reusable) {
        console.log(bad(`the managed volume '${dep.VOLUME}' already holds a house, but no credential for it is available.`));
        console.log('  a generated one would be ignored by the server: the image sets the password only at first init.');
        console.log(`  recover it from the old ${ENV_FILE.replace(os.homedir(), '~')}, or reset the user from inside the house,`);
        console.log('  or start over and lose the memory:  memhouse deploy --down');
        process.exitCode = 2; break;
      }
      // A service-managed solo house must not be switched out from under its own units.
      if (String(priorCfg.solo) === '1') {
        let svcSolo = { installed: false };
        try { svcSolo = require(path.join(REPO_ROOT, 'mem-house', 'service.js')).status().solo || { installed: false }; } catch { /* unsupported */ }
        if (svcSolo.installed) {
          console.log(bad('a service-managed solo house is installed — switching tiers would leave it shipping to the old port.'));
          console.log('  remove it first:  memhouse service uninstall');
          process.exitCode = 2; break;
        }
      }

      // Validation passed. From here the command changes things.
      //
      // A running solo shim owns the port this container wants — 8123 for both by default
      // — so the container's bind would fail and the documented solo->local switch could
      // not happen. The shim we manage is stopped; a service-managed one was refused above.
      if (String(priorCfg.solo) === '1') {
        const soloPid = pidOf('solo');
        if (soloPid) {
          console.log(warn(`stopping the solo house (pid ${soloPid}) — the server tier takes over`));
          try { process.kill(soloPid, 'SIGTERM'); } catch { /* raced */ }
          try { fs.unlinkSync(path.join(RUN_DIR, 'solo.pid')); } catch { /* absent */ }
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      // Detached clients hold a SNAPSHOT of the connection in their environment, taken
      // when they were spawned. Leaving them up across a tier switch means a shipper and
      // dashboard still using `default` with no password against a server that now wants
      // a credential — reported as running, failing every request. `memhouse start` brings
      // them back with the new config; the install line at the end already says to run it.
      for (const name of ['shipper', 'dashboard']) {
        const pid = pidOf(name);
        if (!pid) continue;
        console.log(warn(`stopping ${name} (pid ${pid}) — it holds the old connection`));
        try { process.kill(pid, 'SIGTERM'); } catch { /* raced */ }
        try { fs.unlinkSync(path.join(RUN_DIR, `${name}.pid`)); } catch { /* absent */ }
      }
      const pw = reusable || crypto.randomBytes(16).toString('hex');
      if (reusable) console.log(ok('reusing the existing house credential (its data volume is already initialised)'));
      // The persisted URL is part of the precedence chain, as the solo port is: a bare
      // re-deploy after `--house-port 18123` would otherwise remove the working container
      // and rebuild it on 8123, relocating the house and rewriting its URL — or leaving it
      // stopped if 8123 is taken.
      const persistedPort = String(priorCfg.solo) === '1' ? '' : portOf(priorCfg.url);
      const port = String(housePort || process.env.MEMHOUSE_CH_PORT || persistedPort || 8123);
      const r = dep.up({ password: pw, port, tag: flags.tag || process.env.MEMHOUSE_CH_TAG });
      if (!r.ok) { console.log(bad(r.msg)); process.exitCode = 1; break; }
      console.log(ok(`ClickHouse starting via ${r.engine} on ${r.url} (loopback only)`));
      if (!(await dep.waitReady(r.url))) {
        console.log(bad(`ClickHouse did not answer on ${r.url} — check: ${r.engine} logs ${dep.CONTAINER}`));
        process.exitCode = 1; break;
      }
      console.log(ok('ClickHouse ready'));
      // Switching tiers must clear the other one. A house that was solo yesterday still
      // has MEMHOUSE_SOLO=1 in its config, and cmdInstall would write it straight back —
      // so the next `start` would launch a shim nobody wants, flapping on the ClickHouse
      // port or quietly serving the stale embedded house beside the real one.
      // Empty string, not `delete`: resolveConfig falls back to the FILE on an absent env
      // var, and the file still holds the old solo port.
      process.env.MEMHOUSE_SOLO = '0';
      process.env.MEMHOUSE_SOLO_PORT = '';
      flags.url = r.url; flags.user = 'memhouse_root'; flags.password = pw;
      flags.db = flags.db || process.env.MEMHOUSE_DB || 'memhouse';
      flags.yes = true;
      process.exitCode = await cmdInstall({ interactive: false });
      break;
    }
    case 'service': {
      const svc = require(path.join(REPO_ROOT, 'mem-house', 'service.js'));
      const sub = positional[0] || 'status';
      if (sub === 'install') {
        // A solo house lives in this machine's own shim process, so the service has to
        // bring that back too — otherwise the reboot the service exists to survive leaves
        // the shipper talking to a dead port. Detected from the configured URL: solo is
        // the only tier whose house is a loopback shim this CLI itself started.
        const cfg = resolveConfig();
        const solo = String(cfg.solo) === '1' || flags.solo === true;
        const soloPort = solo ? (cfg.soloPort || new URL(cfg.url).port || '8123') : null;
        // The service supersedes the pidfile daemons, and they are not merely redundant:
        // the shim binds a fixed port, so leaving the detached one alive makes the new
        // unit fail with EADDRINUSE and flap under Restart=on-failure. Hand over rather
        // than run both. The dashboard is not service-managed, so it is left alone.
        for (const name of ['shipper', 'solo']) {
          const pid = pidOf(name);
          if (!pid) continue;
          try { process.kill(pid, 'SIGTERM'); console.log(ok(`${name} daemon stopped — the service takes it over (pid ${pid})`)); } catch { /* raced */ }
          try { fs.unlinkSync(path.join(RUN_DIR, `${name}.pid`)); } catch { /* absent */ }
        }
        const r = svc.install({
          shipJs: SHIP_JS, envFile: ENV_FILE, logDir: LOG_DIR, interval: flags.interval || 300,
          soloJs: solo ? SOLO_JS : null, soloPort,
          // Where this install lives. The env file records the connection, not the home
          // that contains it, and the shim's data directory hangs off the home.
          home: HOME_DIR,
          soloData: process.env.MEMHOUSE_SOLO_DATA || null,
        });
        if (!r.ok) { console.log(bad(r.msg)); process.exitCode = 1; break; }
        console.log(ok(`service installed (${r.kind}): ${r.path}`));
        if (r.soloPath) console.log(ok(`solo house service installed: ${r.soloPath}`));
        console.log(r.warn ? '  starts at login; `memhouse start` is no longer needed'
                            : '  survives reboot; `memhouse start` is no longer needed');
        if (r.warn) console.log(warn(r.warn));
      } else if (sub === 'uninstall') {
        const r = svc.uninstall();
        console.log(r.ok ? ok(`service removed (${r.kind})`) : bad(r.msg));
        // A refusal is a failure. Silence here told automation the credential-bearing
        // unit was gone while it was still installed and possibly still shipping.
        if (!r.ok) process.exitCode = 1;
      } else {
        const st = svc.status();
        if (!st.kind) { console.log(warn(`no service integration for '${process.platform}'`)); break; }
        console.log(st.installed ? ok(`service installed (${st.kind}): ${st.path}`) : warn('service not installed'));
        console.log(st.running ? ok('service running') : warn('service not running'));
        if (st.solo.installed) {
          console.log(ok(`solo house service installed: ${st.solo.path}`));
          console.log(st.solo.running ? ok('solo house service running') : warn('solo house service not running'));
        }
      }
      break;
    }
    case 'uninstall': cmdUninstall(); break;
    default:
      console.error(`unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 2;
  }
})().catch((e) => { console.error(bad(e.message)); process.exit(1); });
