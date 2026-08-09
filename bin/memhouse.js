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
const { roomNames, ROOM_TYPES, mergeRooms } = require(path.join(REPO_ROOT, 'mem-house', 'per-member', 'rooms'));
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

// A config written by the solo tier points at a shim this build cannot start. Left
// alone it reads as an ordinary external house that happens to be down, so `start`
// launches a shipper and dashboard against a dead endpoint and `doctor` reports a
// generic connection failure. Refuse, and say the two things that actually work.
//
// Commands that are the way OUT stay allowed — including, emphatically, the ones the
// refusal message itself recommends. A guard that blocks its own advice leaves the user
// editing the env file by hand.
//
//   deploy   — `--local` rewrites the config, which is what ENDS this state; `--down`
//              only removes a container.
//   service  — `status` is how the stale-unit warning is seen and `uninstall` is how it
//              is removed; only `service install` is blocked, since installing a unit
//              pointed at the dead shim is the one thing here that makes it worse.
const LEGACY_SOLO_OK = new Set([
  'setup', 'uninstall', 'discover', 'plugins', 'prompt', 'stop', 'deploy', 'help', 'version', null,
]);

function legacySoloGuard() {
  let file = {};
  try { file = envfile.parse(fs.readFileSync(ENV_FILE, 'utf-8')); } catch { return false; }
  if (file.MEMHOUSE_SOLO !== '1') return false;
  if (LEGACY_SOLO_OK.has(cmd)) return false;
  if (cmd === 'service' && positional[0] !== 'install') return false;
  console.log(bad(`${ENV_FILE.replace(os.homedir(), '~')} was written by the solo tier, which this version removed.`));
  console.log(`  It points at ${file.MEMHOUSE_URL || 'an embedded shim'}, and nothing here can start that.`);
  console.log('');
  console.log('  Your transcripts are not lost — memhouse ships FROM your local session stores,');
  console.log('  so a new house rebuilds them. Point at one and re-ship:');
  console.log('     memhouse deploy --local          (a ClickHouse in docker or podman)');
  console.log('     memhouse setup --url … --user … --password …   (one you already run)');
  console.log('     memhouse ship --full');
  console.log('');
  console.log('  The old embedded data is chdb-format and only readable by chdb; keep');
  console.log(`  ${path.join(HOME_DIR, 'solo-data').replace(os.homedir(), '~')} if you want it, or delete it.`);
  console.log('  Then, for anything the old version left behind:');
  console.log('     memhouse stop              (reaps a shim still running)');
  console.log('     memhouse service status    (shows a stale unit, if there is one)');
  console.log('     memhouse service uninstall (removes it)');
  return true;
}

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
    db: pick('db', 'MEMHOUSE_DB', 'mem'),
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
  const sq = envfile.quoteShell;
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
  // Both settings, always: `final` collapses ReplacingMergeTree versions, and
  // `join_use_nulls` is what the session rollup's coalesce depends on now that it is a
  // saved query rather than a view carrying its own SETTINGS clause.
  const params = new URLSearchParams({ final: '1', join_use_nulls: '1' });
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

/**
 * Is this house a pre-0.4 one?
 *
 * 0.3.x kept three rooms named `sessions`/`messages`/`tool_calls` plus a stored
 * `sessions_v` view, shared by everyone and separated by row policies. 0.4.0 deleted that
 * layout. The database NAME survives an upgrade — explicit MEMHOUSE_DB outranks the new
 * `mem` default — but the TABLES do not, so every read and write fails with UNKNOWN_TABLE
 * naming a room the user has never heard of.
 *
 * Saying "run memhouse install" to someone in that state is useless: they did install, and
 * their memory is sitting right there in the house. Detect it and say so.
 */
async function looksLikePre040(cfg) {
  try {
    const rows = await chRows(cfg,
      `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN ('sessions','messages','tool_calls','sessions_v')`,
      { database: '' });
    return rows.map((r) => r.name);
  } catch { return []; }
}

function reportPre040(cfg, member, found) {
  console.log(bad(`'${cfg.db}' holds a pre-0.4 house — ${found.join(', ')} — and 0.4.0 cannot read it.`));
  console.log('  0.4.0 replaced the shared rooms with one set per member. The database name');
  console.log('  survived your upgrade; the table names did not.');
  console.log('');
  console.log('  Your transcripts are NOT lost. memhouse ships FROM your local session stores,');
  console.log('  so the new rooms rebuild from disk. Build them in a NEW house and leave this');
  console.log('  one untouched:');
  console.log(`     memhouse install --force --db mem --admin-user <user> --admin-password <pw> --member ${member}`);
  console.log('     memhouse ship --full');
  console.log('');
  console.log(`  A NEW house, not this one, and --force because the config still points here.`);
  console.log(`  Rebuilding into '${cfg.db}' would put the member rooms beside the old`);
  console.log("  `sessions_v`, which the `^sessions_` team-room selector matches — every");
  console.log('  session would then be counted twice.');
  console.log('');
  console.log('  Sessions whose transcripts you have since deleted locally live only in the old');
  console.log(`  tables. Read them there before dropping anything: SELECT * FROM ${cfg.db}.sessions`);
}

/** Is anything listening on this loopback port? */
function portInUse(port) {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(Number(port), '127.0.0.1');
  });
}

/**
 * Same house? Host AND port, normalised. Comparing ports alone called a service pointing
 * at `http://remote-house:8123` a match for a local container publishing 8123.
 * localhost/127.0.0.1/::1 are the same machine and must compare equal.
 */
function sameEndpoint(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(u);
      const host = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(x.hostname) ? 'local' : x.hostname;
      return `${host}:${x.port || (x.protocol === 'https:' ? '443' : '80')}`;
    } catch { return null; }
  };
  const na = norm(a); const nb = norm(b);
  return na !== null && nb !== null && na === nb;
}

/** Port from a configured URL, '' when it has none or the URL is unparseable. */
function portOf(u) {
  try { return new URL(u).port || ''; } catch { return ''; }
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
  const rows = await chRows(cfg, 'SELECT currentUser() AS u');
  const member = rows[0] && rows[0].u;
  if (!member) throw new Error('could not determine currentUser() for room resolution');
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
                                  --print-sql            print the SQL, run it yourself
                                  with admin: --admin-user --admin-password [--member NAME]
                                  builds house + user + rooms + grants, then verifies as
                                  the member. The admin credential is never stored.
             setup                (re)write the connection config only (--yes = no prompts)
             discover             read-only preflight: editors, sessions, reachable ClickHouses
             uninstall            stop daemons + remove ${HOME_DIR.replace(os.homedir(), '~')} (house data untouched)
             reset                truncate the house tables and re-ship everything (--yes to skip confirm)

Data         ship                 one incremental pass (--full | --loop [sec])
             stats                per-source session/message/token counts
             search <terms…>      full-text search across all sessions
             sessions-query       print the session rollup SQL for this credential
             start | stop |       shipper loop + dashboard as background daemons
             status               daemons, connection, counts, freshness (--json)
             doctor               diagnose the whole pipeline

Agents       plugins              list | install claude [--target DIR] | remove claude
             prompt               print the memory system-prompt snippet
             prompt --install     print an install prompt for an agent, with this
                                  machine's state and the one route that applies

House        deploy --local       run ClickHouse in docker/podman, then install
             deploy --down        remove the local house (container + volume)
                                  [--house-port N] [--tag 25.11]  (--port is the dashboard)
             service install      run the shipper as a user service (systemd / launchd)
             service uninstall | status

Config: flags > MEMHOUSE_* env > ${ENV_FILE.replace(os.homedir(), '~')} > defaults.
Engine: MEMHOUSE_ENGINE pins docker or podman when both are installed and one cannot answer.
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
  return out;
}

/**
 * Render the agent install prompt with this machine's facts.
 *
 * The value is in what it removes: the CLI has already probed for a house, an engine and
 * an existing config, so the prompt can state the ONE route that applies. A static
 * runbook makes the agent derive that from a decision tree, which is where it picks the
 * wrong branch — most expensively by asking a user with no ClickHouse for a ClickHouse
 * URL, which is exactly what onboard itself used to do.
 */
async function renderInstallPrompt() {
  const tplPath = path.join(DELIVERY, 'AGENT-INSTALL-PROMPT.md');
  const tpl = fs.readFileSync(tplPath, 'utf-8');
  const body = tpl.split('<!-- PROMPT BODY BELOW -->')[1] || tpl;

  const cfg = resolveConfig();
  const configured = fs.existsSync(ENV_FILE);
  const engines = deployableEngines();

  // Probe rather than assume. JSON_OUT is forced off so cmdDiscover returns its object
  // instead of printing JSON and returning undefined.
  const saved = JSON_OUT;
  let found = null;
  try {
    found = await withSuppressedOutput(() => cmdDiscover());
  } catch { /* fall through to the unknown-state wording */ } finally { void saved; }

  const editors = (found && found.editors || []).filter((e) => e.sessions > 0);
  const reachable = (found && found.clickhouse || []).filter((p) => p.reachable);
  const houseUp = reachable.length > 0;

  // Is an existing install actually working, or configured-but-broken? A broken one is
  // the case a plain "install it" prompt handles worst.
  let state = 'not installed';
  if (configured) {
    let ok0 = false;
    try { ok0 = !!(await ch(cfg, 'SELECT 1')); } catch { ok0 = false; }
    state = ok0 ? 'installed and connected' : 'configured, but the house does not answer';
  }

  let plan;
  if (state === 'installed and connected') {
    plan = `memhouse is already installed and connected to \`${cfg.url}\` (database \`${cfg.db}\`).
**Do not reinstall.** Verify and hand back:

1. \`memhouse doctor\` — every line should be a check mark.
2. \`memhouse status\` — note the session and message counts.
3. If the shipper is not running: \`memhouse start\`.
4. If \`doctor\` reports rooms missing, the house may predate 0.4.0; it will say so by
   name and print the recovery. Follow what it prints rather than reinstalling.`;
  } else if (state.startsWith('configured')) {
    plan = `memhouse is configured to use \`${cfg.url}\` (database \`${cfg.db}\`) but that
endpoint does not answer. Do NOT reconfigure before finding out why.

1. Is the house simply stopped? If it was a local container, \`memhouse deploy --local\`
   brings the same volume back — it does not lose data.
2. Is it a remote house the user's network cannot reach right now? Ask them; do not
   repoint their config at something else on your own initiative.
3. Only once the user says the old house is gone for good should you set up a new one,
   and then say plainly that past sessions re-ship from local transcripts but anything
   whose transcript was deleted lives only in the old house.`;
  } else if (houseUp) {
    plan = `A ClickHouse is already reachable at \`${reachable[0].url}\`. Use it.

1. \`npm install -g memhouse --allow-scripts=better-sqlite3\`
   The flag is not optional — six adapters (cursor, zed, opencode, goose, windsurf,
   antigravity) read SQLite stores and silently drop out without the native build.
2. Ask the user for the ClickHouse username and password for that endpoint.
3. \`memhouse install --url ${reachable[0].url} --user <user> --password <pw>\`
   If they hold admin on it and want memhouse to create the user, database, rooms and
   grants for them, use \`--admin-user\`/\`--admin-password\` instead; memhouse then
   reconnects as the new member and never stores the admin credential.
   If they would rather run the SQL themselves, \`memhouse install --print-sql\` prints
   it and touches nothing.
4. \`memhouse start\`.`;
  } else if (engines.length) {
    plan = `There is no ClickHouse to point at, but **${engines.join(' and ')}** is available,
so memhouse can run one:

1. \`npm install -g memhouse --allow-scripts=better-sqlite3\`
   The flag is not optional — six adapters read SQLite stores and silently drop out
   without the native build.
2. \`memhouse deploy --local\`
   This starts a loopback-only ClickHouse, generates a credential, installs, creates the
   user's rooms and runs the first ship. One command, no questions.
3. \`memhouse start\`.

${process.platform === 'linux' && engines.includes('podman')
    ? 'On Linux with rootless podman the container stops at logout unless lingering is on.\nIf memhouse warns about this, run what it prints (`loginctl enable-linger <user>`)\nand tell the user why it matters.' : ''}`;
  } else {
    plan = `There is no ClickHouse reachable and no container engine to run one with. You
cannot finish this install alone — say so rather than improvising.

Tell the user they need one of:
- a ClickHouse they already run (Cloud, a server, a kernel house) plus its credentials;
- docker or podman installed, after which \`memhouse deploy --local\` does everything.

You can still do the harmless half now: \`npm install -g memhouse --allow-scripts=better-sqlite3\`,
then \`memhouse discover\` to show them what would be shipped once a house exists.`;
  }

  const out = body
    .replaceAll('{{VERSION}}', PKG.version)
    .replaceAll('{{PLATFORM}}', `${process.platform}/${process.arch}`)
    .replaceAll('{{NODE}}', process.versions.node)
    .replaceAll('{{STATE}}', state)
    .replaceAll('{{EDITORS}}', editors.length
      ? editors.map((e) => `${e.source} (${e.sessions})`).join(', ')
      : 'none found — memhouse would ship nothing until an editor is used')
    .replaceAll('{{HOUSE}}', houseUp ? reachable.map((p) => p.url).join(', ') : 'none reachable')
    .replaceAll('{{ENGINES}}', engines.length ? engines.join(', ') : 'none (no docker, no podman)')
    .replaceAll('{{PLAN}}', plan.trim())
    .replaceAll('{{PORT}}', String(cfg.port));
  process.stdout.write(out.trimStart());
  return 0;
}

/** Run a printing function with stdout swallowed, and give back its return value. */
async function withSuppressedOutput(fn) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return await fn(); } finally { process.stdout.write = write; }
}

/**
 * Can this machine stand up a house of its own?
 *
 * Returns the container engines on PATH, or [] — which is also what a platform with no
 * deploy support returns, so callers need no second check. `deploy --local` exists and has
 * since 0.4.0, but nothing ever mentioned it: a first-timer with no ClickHouse was told
 * "fix the connection" by the one command whose whole job is to get them connected.
 */
function deployableEngines() {
  try { return require(path.join(REPO_ROOT, 'mem-house', 'deploy.js')).availableEngines() || []; }
  catch { return []; }
}

/** The offer itself, so install and onboard cannot drift into wording it differently. */
function printLocalHouseOffer(engines) {
  if (!engines.length) {
    console.log('  No ClickHouse to point at? memhouse can run one for you, but that needs');
    console.log('  docker or podman — neither is on PATH.');
    return false;
  }
  console.log(`  No ClickHouse to point at? memhouse can run one (${engines.join(' or ')}):`);
  console.log('     memhouse deploy --local');
  console.log('  That starts the container, generates a credential, installs and ships.');
  return true;
}

// ── the member handle ───────────────────────────────────────────────────────────
// The ClickHouse user IS the identity; rooms are named for whatever the server answers
// to currentUser(). The home directory only produces a SUGGESTION, and a suggestion that
// had to be changed is printed rather than applied quietly — sanitizing collides
// (`ramazan.polat` and `ramazan-polat` both land on `ramazan_polat`), so the human has to
// see it.
function suggestMember() {
  const base = path.basename(os.homedir() || '');
  const clean = base.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(clean)) return { handle: null, why: `'${base}' does not start with a letter` };
  if (clean === 'root') return { handle: null, why: "'root' is a container artefact, not a person" };
  return { handle: clean, changed: clean !== base ? base : null };
}

function generatePassword() {
  // 32 chars from a set with no shell or SQL metacharacters — this value is pasted into
  // terminals and quoted into unit files, and a clever password is not worth a support case.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(32)).map((b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Option 1 — the SQL, for a human with admin who would rather not hand it over.
 *
 * This is the whole install as statements: nothing else runs behind it, and running it by
 * hand produces exactly what `--admin-user` would have produced. It is rendered from the
 * same templates provision.js applies, so the two cannot drift into different houses.
 */
function memberSql(db, member, password) {
  const here = path.join(REPO_ROOT, 'mem-house', 'per-member');
  // The templates are written unqualified because provision.js applies them with the
  // house already selected. A human pastes this somewhere unknown — clickhouse-client,
  // the play UI, curl — so every name is qualified here and there is no `USE`.
  //
  // `currentDatabase()` in the Merge engine is the trap, and it is silent:
  // it is evaluated at CREATE time, not at read time, so a block run without the house
  // selected builds Merge rooms pointing at `default` that return zero rows forever. The
  // literal name goes in instead.
  const qualify = (sql) => sql
    .replace(/CREATE TABLE IF NOT EXISTS (\w+)/g, `CREATE TABLE IF NOT EXISTS ${db}.$1`)
    .replace(/ AS (\w+)\nENGINE = Merge/g, ` AS ${db}.$1\nENGINE = Merge`)
    .replace(/Merge\(currentDatabase\(\)/g, `Merge('${db}'`);
  const rooms = qualify(fs.readFileSync(path.join(here, 'schema-member.sql.tpl'), 'utf-8')
    .replaceAll('{{MEMBER}}', member));
  const merge = qualify(fs.readFileSync(path.join(here, 'schema-merge.sql.tpl'), 'utf-8')
    .replaceAll('{{TEMPLATE_MEMBER}}', member));
  const grants = ROOM_TYPES.flatMap((t) => [
    `GRANT ALL ON ${db}.${t}_${member} TO ${member};`,
    `GRANT SELECT ON ${db}.${t}_${member} TO ${member} WITH GRANT OPTION;`,
  ]).join('\n');
  const mergeGrants = Object.values(mergeRooms())
    .map((n) => `GRANT SELECT ON ${db}.${n} TO ${member};`).join('\n');
  return `-- memhouse: everything '${member}' needs in house '${db}'. Run as a user with
-- ACCESS MANAGEMENT (a stock 'default' with access_management=1 will do).
--
-- Every name is qualified and there is no USE, so this runs anywhere: clickhouse-client,
-- the play UI, curl, a GUI. Order matters only in that the database comes first.
--
-- The messages room carries two text indexes. ClickHouse 25.x gates them behind
-- allow_experimental_full_text_index and refuses the CREATE without it (Code: 344);
-- 26.x accepts the setting as a no-op. The SET below covers any client that keeps a
-- session — clickhouse-client, a GUI. Over HTTP, where each statement is its own
-- request and SET does not persist, put it in the URL instead:
--     curl "\$URL/?allow_experimental_full_text_index=1&multiquery=1" --data-binary @-
-- multiquery=1 matters because this is one POST carrying many statements; without it
-- ClickHouse parses only the first and reports a syntax error on the rest.

SET allow_experimental_full_text_index = 1;

CREATE DATABASE IF NOT EXISTS ${db};
CREATE USER ${member} IDENTIFIED BY '${password.replace(/'/g, "\\'")}';

${rooms.trim()}

-- ALL is not re-grantable; SELECT is. The member owns their rooms outright — DROP
-- included, it is their memory — but a share can only ever be read-only.
${grants}

-- Team-wide reads. A Merge room reduces to the rooms the CALLER holds grants for, so
-- this narrows rather than denies, and picks up members added later with no DDL.
${merge.trim()}

${mergeGrants}
`;
}

/**
 * Mode B — admin bootstrap. Five verbs, then a reconnect AS THE MEMBER before anything is
 * written, because a mode that only ever proves the admin could do it has proven nothing
 * about the credential it is about to persist.
 *
 * The admin credential is never persisted: not to the env file, not to a unit, not to a
 * log. A shipper running as the house owner makes per-member rooms decoration.
 */
async function adminBootstrap(cfg, admin) {
  const adminCfg = { ...cfg, user: admin.user, password: admin.password };
  const q = (sql, opts) => ch(adminCfg, sql, opts);

  try { await q('SELECT 1', { database: '' }); }
  catch (e) { console.log(bad(`admin connection failed: ${e.message}`)); return null; }

  // 1. the house
  try { await q(`CREATE DATABASE IF NOT EXISTS ${cfg.db}`, { database: '' }); }
  catch (e) {
    try { await q('SELECT 1'); }
    catch { console.log(bad(`house '${cfg.db}' does not exist and '${admin.user}' cannot create it: ${e.message}`)); return null; }
  }

  // 2. the user. An EXISTING user is refused: adopting one silently hands the second
  // human the first's identity and rooms, and user_id MATERIALIZED currentUser() would
  // stamp them identically, so nothing downstream would ever notice.
  const exists = (await chRows(adminCfg, `SELECT name FROM system.users WHERE name = '${admin.member}'`, { database: '' })).length > 0;
  let password = flags['member-password'] || null;
  if (exists) {
    if (flags['adopt-user'] !== true) {
      console.log(bad(`ClickHouse user '${admin.member}' already exists in this house.`));
      console.log('  Creating rooms for them would hand you their identity — user_id is stamped from');
      console.log('  currentUser(), so their rows and yours would be indistinguishable.');
      console.log('  If this is you on a new machine, prove it:');
      console.log(`     memhouse install --adopt-user --member ${admin.member} --member-password '…' …`);
      console.log(`  If it is someone else, pick another handle:  --member <name>`);
      return null;
    }
    if (!password) { console.log(bad('--adopt-user requires --member-password — the password is the proof')); return null; }
    try { await ch({ ...cfg, user: admin.member, password }, 'SELECT 1', { database: '' }); }
    catch { console.log(bad(`--adopt-user: '${admin.member}' did not authenticate with that password`)); return null; }
    console.log(ok(`adopted existing user '${admin.member}' (password verified)`));
  } else {
    if (!password) {
      password = generatePassword();
      console.log('');
      console.log(`  password for '${admin.member}':  ${password}`);
      console.log('  Shown once. It goes into ~/.memhouse/env; to change it later:');
      console.log(`     ALTER USER ${admin.member} IDENTIFIED BY '…'   then: memhouse setup --password …`);
      console.log('');
    }
    try { await q(`CREATE USER ${admin.member} IDENTIFIED BY '${password.replace(/'/g, "\\'")}'`, { database: '' }); }
    catch (e) { console.log(bad(`could not create user '${admin.member}': ${e.message}`)); return null; }
    console.log(ok(`created ClickHouse user '${admin.member}'`));
  }

  // 3. rooms, 4. grants, 5. Merge rooms + their grant — provision.js owns all of it, so
  // there is one implementation of the grant set rather than two that drift.
  const provision = path.join(REPO_ROOT, 'mem-house', 'per-member', 'provision.js');
  const rc = spawnSync(process.execPath, [provision, '--member', admin.member, '--merge'], {
    stdio: 'inherit',
    env: { ...process.env, MEM_URL: cfg.url, MEM_USER: admin.user, MEM_PASSWORD: admin.password, MEM_DB: cfg.db },
  });
  if (rc.status !== 0) { console.log(bad('provisioning failed — nothing was written')); return null; }

  // The step that makes this trustworthy: stop being admin, and prove the credential we
  // are about to persist actually reaches the rooms.
  const memberCfg = { ...cfg, user: admin.member, password };
  try {
    const seen = await chRows(memberCfg, `SELECT count() AS n FROM system.tables WHERE database = '${cfg.db}' AND name IN ('sessions_${admin.member}','messages_${admin.member}','tool_calls_${admin.member}')`, { database: '' });
    if (Number(seen[0]?.n) !== 3) { console.log(bad(`'${admin.member}' cannot see all three of their rooms — nothing written`)); return null; }
  } catch (e) { console.log(bad(`'${admin.member}' could not connect after provisioning: ${e.message}`)); return null; }
  console.log(ok(`verified as '${admin.member}' — admin credential discarded, not stored`));
  return memberCfg;
}

// The handle, decided once for whichever option runs. Returns null after reporting.
function resolveMemberHandle() {
  const s = suggestMember();
  const member = flags.member || s.handle;
  if (!member) { console.log(bad(`no member handle: ${s.why}. Pass --member <name>.`)); return null; }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(member)) {
    console.log(bad(`'${member}' cannot name a room — expected [A-Za-z][A-Za-z0-9_]*`));
    return null;
  }
  if (!flags.member && s.changed) console.log(warn(`member handle '${s.changed}' sanitized to '${member}' — pass --member to choose another`));
  return member;
}

async function cmdInstall({ interactive }) {
  let cfg = resolveConfig();
  const adminUser = flags['admin-user'];

  // Option 1 — print the SQL and stop. For the common case: you have admin on this
  // ClickHouse and would rather run four statements yourself than hand a credential to an
  // installer. Nothing is written and nothing is contacted.
  if (flags['print-sql'] === true) {
    const member = resolveMemberHandle();
    if (!member) return 1;
    const password = flags['member-password'] || generatePassword();
    console.log(memberSql(cfg.db, member, password));
    console.log(`-- Then, once that has run:`);
    console.log(`--   memhouse install --url ${cfg.url} --db ${cfg.db} --user ${member} --password '${password}'`);
    return 0;
  }

  // Option 2 — admin bootstrap. Decided by one question: do you hold admin here?
  if (adminUser) {
    const member = resolveMemberHandle();
    if (!member) return 1;
    const built = await adminBootstrap(cfg, {
      user: adminUser, password: flags['admin-password'] || '', member,
    });
    if (!built) return 1;
    cfg = built;
    writeEnvFile(cfg);
    console.log(ok(`config written: ${ENV_FILE}`));
    if (flags['no-ship'] !== true && run(SHIP_JS, [], cfg) !== 0) return 1;
    console.log(ok('installed — next: memhouse start   (dashboard + shipper loop)'));
    console.log('  admin is needed again only for: a second member, or an ADD COLUMN rollout.');
    console.log('     node mem-house/per-member/provision.js --member <name> --merge');
    return 0;
  }

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
  // An existing config pointing somewhere ELSE is not a thing to overwrite in passing: a
  // shipper or an installed service is still pointed at the old house, and rewriting the
  // file orphans it with no error anywhere.
  const prior = readEnvFile();
  if (prior.MEMHOUSE_URL && flags.force !== true
      && (!sameEndpoint(prior.MEMHOUSE_URL, cfg.url) || (prior.MEMHOUSE_DB && prior.MEMHOUSE_DB !== cfg.db))) {
    console.log(bad(`${ENV_FILE} already points at ${prior.MEMHOUSE_URL} / ${prior.MEMHOUSE_DB || '?'}`));
    console.log(`  installing over it would leave any running shipper or service on the old house.`);
    console.log('     memhouse setup --url … --db …     (move deliberately)');
    console.log('     memhouse install --force …        (overwrite anyway)');
    return 1;
  }
  // Preflight WITHOUT selecting the house — on a fresh standalone ClickHouse the
  // database doesn't exist yet, and selecting it would fail before we can create it.
  try { await ch(cfg, 'SELECT 1', { database: '' }); }
  catch (e) {
    console.log(bad(`connection failed: ${e.message}`));
    printLocalHouseOffer(deployableEngines());
    console.log('  Already have one? Fix the connection, then re-run: memhouse install');
    return 1;
  }
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
  // Rooms — the caller's own three. On a house you own this creates them and you are
  // done, which is the solo path. On a house someone else owns you hold no CREATE TABLE,
  // and that is not a failure to paper over: rooms and grants are minted by the owner, so
  // the step reports what is missing and names the command that fixes it.
  const r = await roomsFor(cfg);
  // Three rooms. The session rollup is a saved query over them, not a fourth object.
  const want = ROOM_TYPES.map((t) => r[t]);
  const present = async () => {
    const list = `'${want.join("','")}'`;
    return (await chRows(cfg, `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN (${list})`, { database: '' })).map((x) => x.name);
  };
  let have = [];
  try { have = await present(); } catch (e) { console.log(bad(`could not list rooms: ${e.message}`)); return 1; }
  if (have.length !== want.length) {
    // Check for a pre-0.4 house BEFORE trying to mint anything. `--ensure-schema` on one
    // of those dies with an UNKNOWN_TABLE stack trace, and a stack trace printed above a
    // clean explanation is how a clear message gets missed.
    const legacy = await looksLikePre040(cfg);
    if (legacy.length) { reportPre040(cfg, r.member, legacy); return 1; }
    // Try to mint them as ourselves before asking anyone for anything.
    run(SHIP_JS, ['--ensure-schema'], cfg);
    try { have = await present(); } catch { /* reported below */ }
  }
  const missing = want.filter((n) => !have.includes(n));
  if (missing.length) {
    console.log(bad(`'${r.member}' has no ${missing.join(', ')} in '${cfg.db}', and could not create them`));
    console.log('  You hold no CREATE TABLE here. Someone with ACCESS MANAGEMENT has to run this —');
    console.log('  print it with:  memhouse install --print-sql --member ' + r.member);
    console.log('  or hand it over:  memhouse install --admin-user … --admin-password …');
    return 1;
  }
  console.log(ok(`rooms for '${r.member}': ${want.join(', ')}`));
  // Written LAST, and only once everything above proved out. Writing it first leaves a
  // config file behind every failed attempt, and the next command reads it as truth.
  writeEnvFile(cfg);
  console.log(ok(`config written: ${ENV_FILE}`));
  if (flags['no-ship'] !== true) {
    if (run(SHIP_JS, [], cfg) !== 0) return 1;
  }
  console.log(ok('installed — next: memhouse start   (dashboard + shipper loop)'));
  return 0;
}

async function cmdOnboard() {
  console.log(`memhouse ${PKG.version} — onboarding\n`);
  const found = await cmdDiscover();
  console.log('');
  // discover has just probed every candidate endpoint and printed the result. Walking
  // straight into "ClickHouse URL:" after finding none asks the user for something they
  // have already been shown they do not have.
  const reachable = (found && found.clickhouse || []).filter((p) => p.reachable);
  if (!reachable.length) {
    const engines = deployableEngines();
    if (engines.length) {
      console.log(warn('No reachable ClickHouse found.'));
      const yn = (await ask(`Run one locally with ${engines[0]}? (Y/n)`, 'Y')).toLowerCase();
      if (yn !== 'n' && yn !== 'no') {
        // Re-enter the CLI as a child rather than calling the deploy path directly. That
        // path is the most heavily guarded code here — ownership, port probes, credential
        // reuse, service drift — and every one of those guards is written against a fresh
        // process reading its own flags. Reaching into it with a synthesised flag object
        // is how one of them silently stops applying.
        const rc = spawnSync(process.execPath, [__filename, 'deploy', '--local'], { stdio: 'inherit' });
        return rc.status === 0 ? 0 : (rc.status || 1);
      }
    } else {
      console.log(warn('No reachable ClickHouse found, and neither docker nor podman is on PATH.'));
      console.log('  Point at one you already run, or install a container engine and use: memhouse deploy --local');
    }
    console.log('');
  }
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
  // Anything an installed service owns must not also be started here. Those pidfiles are
  // deliberately absent — `service install` removed them when it took over — so the
  // "already running?" check below cannot see the service's processes at all.
  //
  // For the shipper that means two loops parsing and clearing the same sessions
  // concurrently, each deleting rows the other just inserted.
  //
  // Reachable in the obvious way: after a reboot the user wants the dashboard back, which
  // is not service-managed, and types `memhouse start`.
  let svcStatus = { installed: false, running: false };
  try { svcStatus = require(path.join(REPO_ROOT, 'mem-house', 'service.js')).status(); } catch { /* unsupported platform */ }
  const owned = [
    ...(svcStatus.installed ? [['shipper', svcStatus.running, 'memhouse-shipper']] : []),
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

// `solo` is here and NOT in the start list on purpose. The tier is gone, but a machine
// that ran it before this upgrade can still have a detached shim alive with its pid in
// run/solo.pid — and `uninstall` deletes MEMHOUSE_HOME, which is where its data directory
// lives. Reaping has to outlive the feature; starting must not.
const LEGACY_DAEMONS = ['solo'];

function cmdStop() {
  let stopped = 0;
  for (const name of ['shipper', 'dashboard', ...LEGACY_DAEMONS]) {
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
    out.member = r.member;
    const s = await chRows(cfg, `SELECT count() AS sessions FROM ${r.sessions_v}`);
    const m = await chRows(cfg, `SELECT count() AS msgs, formatDateTime(max(ingested_at), '%Y-%m-%d %H:%i:%S') AS freshest FROM ${r.messages}`);
    out.sessions = Number(s[0]?.sessions || 0);
    out.messages = Number(m[0]?.msgs || 0);
    out.freshest = m[0]?.freshest || null;
  } catch (e) { out.connected = false; out.error = e.message; }

  if (JSON_OUT) return console.log(JSON.stringify(out, null, 2));
  console.log(out.config ? ok(`config: ${out.config}`) : warn('no config (memhouse install)'));
  console.log(out.connected ? ok(`connected: ${cfg.url} / ${cfg.db} as ${cfg.user}`) : bad(`not connected: ${out.error || cfg.url}`));
  if (out.member) console.log(ok(`rooms for '${out.member}'`));
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
  let rooms = null;
  try { rooms = await roomsFor(cfg); } catch (e) { add(false, 'room resolution', e.message); }
  if (rooms) add(true, `rooms for '${rooms.member}'`);
  try {
    // Three rooms. The session rollup every read path goes through is a saved query over
    // exactly these, so if they are here it is too — there is no fourth object to lose.
    const objects = ROOM_TYPES.map((t) => rooms[t]);
    const want = objects.map((n) => `'${n}'`).join(',');
    const t = (await chRows(cfg, `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN (${want})`, { database: '' })).length;
    const legacy = t === objects.length ? [] : await looksLikePre040(cfg);
    add(t === objects.length, `schema: ${t}/${objects.length} rooms in '${cfg.db}' (${objects.join(', ')})`,
      legacy.length
        ? `pre-0.4 house (${legacy.join(', ')}) — 0.4 cannot read it; see: memhouse install --help, then ship --full`
        : `run: memhouse install, or as the owner: node mem-house/per-member/provision.js --member ${rooms.member}`);
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
  // Which models in this house have no price. An unpriced model is not an error — a new
  // release always lands before pricing.json catches up — but it IS silent: calculateCost
  // returns null and the callers drop it from the total, so the dashboard reports a
  // smaller number that looks entirely plausible. The Claude 5 family sat unpriced for
  // five months that way, understating a real house by 136%.
  try {
    const { calculateCost } = require(path.join(REPO_ROOT, 'pricing'));
    const rows = await chRows(cfg,
      `SELECT model, count() AS n FROM ${rooms.messages} WHERE model NOT IN ('', '<synthetic>') GROUP BY model`);
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    const unpriced = rows.filter((r) => calculateCost(r.model, 1e6, 0, 0, 0) === null);
    const missed = unpriced.reduce((a, r) => a + Number(r.n), 0);
    // Report the COUNT, and the share only when it rounds to something. "0% of messages"
    // beside a real number reads as "nothing is wrong", which is the opposite of the point.
    const pct = total ? (missed / total) * 100 : 0;
    const share = pct >= 0.5 ? `${Math.round(pct)}% of messages` : `${missed} message${missed === 1 ? '' : 's'}`;
    add(unpriced.length === 0,
      unpriced.length === 0
        ? `pricing: every model in this house has a price (${rows.length} models)`
        : `pricing: ${unpriced.length} model${unpriced.length > 1 ? 's' : ''} unpriced — ${share} cost nothing in the dashboard (${unpriced.map((r) => r.model).join(', ')})`,
      'node sync-pricing.js --write   (then re-run doctor)');
  } catch { /* a house that cannot be read is already reported above */ }
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
  // DELETE, not TRUNCATE. Historically for two reasons:
  //   * TRUNCATE is its own privilege, and a member provisioned under the pre-0.4 grant
  //     set (SELECT, INSERT and the two ALTER grants) did not hold it — so `reset` failed
  //     with an authorization error for every normally provisioned member. Today's grant
  //     set is `ALL` on the member's own rooms, which does include TRUNCATE;
  //   * on the removed SHARED layout TRUNCATE was worse than unauthorized, it was wrong:
  //     the rooms held every member's rows, and a row policy scopes reads, not TRUNCATE.
  //     One member resetting would have emptied the house.
  // Neither reason is load-bearing now that a member's room holds only their own rows,
  // but DELETE stays: it is correct in both cases and costs nothing here. The user_id
  // value is BOUND rather than `currentUser()`, which a mutation does not evaluate in the
  // caller's context and which therefore matches nothing at all.
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
  // `legacy` too: a machine that ran the solo tier can have a stale unit and no current
  // one, and skipping the service step there leaves it enabled over a deleted home.
  if (st.kind && (st.installed || (st.legacy || []).length)) {
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
  if (legacySoloGuard()) { process.exitCode = 2; return; }

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
    // The session rollup is a saved query, not an object, so there is no name an agent
    // or a skill can put in a FROM clause. This prints it, resolved for whoever the
    // configured credential is — the substitute for that name.
    case 'sessions-query': {
      const cfg = resolveConfig();
      const r = await roomsFor(cfg);
      console.log(r.sessions_v);
      if (!JSON_OUT) {
        console.error(`-- rollup for '${r.member}'. Read with final=1 and join_use_nulls=1.`);
      }
      break;
    }
    case 'plugins': process.exitCode = cmdPlugins(); break;
    case 'prompt':
      // Two audiences, two prompts. Bare `prompt` is the memory-USAGE snippet that goes
      // into a running agent's system prompt; `--install` is the one you hand an agent
      // that has not installed memhouse yet.
      if (flags.install === true) process.exitCode = await renderInstallPrompt();
      else process.stdout.write(fs.readFileSync(path.join(DELIVERY, 'PROMPT.md'), 'utf-8'));
      break;
    case 'reset': process.exitCode = await cmdReset(); break;
    case 'deploy': {
      const dep = require(path.join(REPO_ROOT, 'mem-house', 'deploy.js'));
      if (flags.down) {
        // A shipper service outlives the house it points at. Tearing down the container
        // and volume beneath it leaves the service retrying an endpoint that is gone —
        // and a later bare `deploy --local` mints a NEW password on the same port, which
        // the service will never learn, while `status` still reports it running.
        // Only a service that points at THIS house. `service install` is supported for
        // external/kernel houses too, and refusing on any installed unit
        // would make an unrelated production shipper block the cleanup of a stale local
        // container. Compare the unit's own inlined URL against the port this container
        // publishes; if that cannot be determined, fail closed.
        let svcCfg = { installed: false, url: null };
        try { svcCfg = require(path.join(REPO_ROOT, 'mem-house', 'service.js')).installedConfig(); } catch { /* unsupported */ }
        if (svcCfg.installed) {
          const pub = dep.publishedPort();
          // Host AND port. Port alone classified a service pointing at
          // `http://remote-house:8123` as targeting a local container publishing 8123,
          // so an unrelated production shipper blocked this teardown.
          const targetsThisHouse = !svcCfg.url || !pub || sameEndpoint(svcCfg.url, `http://localhost:${pub}`);
          if (targetsThisHouse) {
            console.log(bad(`a shipper service is installed and points at ${svcCfg.url || 'a house this command cannot identify'} — removing this house would leave it retrying a dead endpoint.`));
            console.log('  memhouse service uninstall, then memhouse deploy --down');
            process.exitCode = 2; break;
          }
          console.log(warn(`a shipper service is installed but points at ${svcCfg.url} — leaving it alone`));
        }
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
      if (!flags.local) { console.log(bad('usage: memhouse deploy --local | --down')); process.exitCode = 2; break; }
      // VALIDATE FIRST, then act. Everything below that can refuse runs before anything
      // is stopped: a safety refusal that has already killed a healthy shipper and
      // dashboard is worse than the problem it is refusing, and in the missing-credential
      // case those processes may be the last things holding a usable connection.
      const priorCfg = resolveConfig();
      // Ask the engine everything `up()` would refuse for, BEFORE anything is stopped —
      // ownership of BOTH fixed names, and the image. `up()` checks all of it too, but by
      // then the shipper and the dashboard are dead, so a foreign container or a typo'd
      // tag costs a working pipeline to discover.
      const pre = dep.preflight({ tag: flags.tag || process.env.MEMHOUSE_CH_TAG || dep.managedTag() || dep.DEFAULT_TAG });
      if (!pre.ok) { console.log(bad(pre.msg)); process.exitCode = 1; break; }
      const initialised = pre.initialised;
      // The port this house will actually bind, decided ONCE and used everywhere below.
      //
      // The persisted URL is deliberately NOT in this chain. It can point at an external
      // house — a kernel realm, ClickHouse Cloud — and reusing a remote endpoint's port
      // as a local container binding is meaningless. What carries forward is the port an
      // existing MANAGED container publishes, which is the only thing that says "the
      // local house lives here".
      const managedPort = dep.publishedPort();
      const port = String(housePort || process.env.MEMHOUSE_CH_PORT || managedPort || 8123);
      const targetUrl = `http://localhost:${port}`;
      // `initialised` is a fact about the DOCKER VOLUME. `priorCfg` is a fact about
      // whatever the user last pointed at. Those are different things, and treating any
      // non-empty password as the volume's is how they get confused: with the config
      // repointed at an external house, the external credential would be handed to a
      // container that ignores it (the image applies CLICKHOUSE_PASSWORD only when it
      // initialises a data directory), auth would fail against the password the volume
      // actually holds, and the env file would be rewritten with the wrong one — losing
      // the working external config on the way past.
      //
      // So reuse only when the persisted config IS this local house: same endpoint as the
      // one we are about to bind. When it is not, fall through to the missing-credential
      // refusal below, which already says the right things.
      const configIsLocalHouse = !!priorCfg.url && sameEndpoint(priorCfg.url, targetUrl);
      const reusable = initialised && configIsLocalHouse && priorCfg.password ? priorCfg.password : null;

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
        if (priorCfg.password && !configIsLocalHouse) {
          console.log(`  ${ENV_FILE.replace(os.homedir(), '~')} holds a credential for ${priorCfg.url}, which is not this house —`);
          console.log(`  reusing it would hand ${targetUrl} a password its volume was never initialised with.`);
        }
        console.log('  a generated one would be ignored by the server: the image sets the password only at first init.');
        console.log(`  recover it from the old ${ENV_FILE.replace(os.homedir(), '~')}, or reset the user from inside the house,`);
        console.log('  or start over and lose the memory:  memhouse deploy --down');
        process.exitCode = 2; break;
      }
      // Moving the local house has two hazards: an occupied destination, and a shipper
      // this loop cannot see. `port` and `targetUrl` are decided above, before the
      // credential-reuse question, because answering that question needs them.
      //
      // The running image tag carries forward too. A house deployed with `--tag 26.7` and
      // then bare-redeployed would have its healthy newer container removed and its
      // volume mounted into 25.11 — and an older ClickHouse may simply refuse data and
      // metadata a newer one wrote. Nothing persists the tag, so read it off the
      // container that is running.
      const tag = flags.tag || process.env.MEMHOUSE_CH_TAG || dep.managedTag() || dep.DEFAULT_TAG;
      // The database is part of the destination, not a detail of it — see the service
      // check below, which must compare it.
      const targetDb = flags.db || process.env.MEMHOUSE_DB || priorCfg.db || 'mem';
      {
        // A service-managed shipper keeps the environment it was installed with, so ANY
        // switch that repoints the config leaves it shipping somewhere else — not only an
        // explicit port move. A bare `deploy --local` over a config pointing at an
        // external house is the case that used to slip through: `to` was empty, the check
        // was skipped, and `status` would then report a running shipper beside counts
        // from a different house.
        let svcCfg = { installed: false, url: null };
        try { svcCfg = require(path.join(REPO_ROOT, 'mem-house', 'service.js')).installedConfig(); } catch { /* unsupported */ }
        // Endpoint AND database. Same URL with a different database is still somewhere
        // else: `deploy --local --db memories` over a service holding `mem` would pass a
        // URL-only check and split reads from service writes.
        const svcElsewhere = svcCfg.installed
          && (!sameEndpoint(svcCfg.url, targetUrl) || (svcCfg.db && svcCfg.db !== targetDb));
        if (svcElsewhere) {
          const where = svcCfg.url ? `${svcCfg.url} / ${svcCfg.db || '?'}` : 'an endpoint this command cannot read';
          console.log(bad(`the shipper is service-managed and holds ${where} — deploying to ${targetUrl} / ${targetDb} would leave it shipping there.`));
          console.log('  memhouse service uninstall, then deploy, then memhouse service install');
          process.exitCode = 2; break;
        }
        // And probe the destination before demolishing anything: `run -p` only discovers
        // the conflict after the old container is gone, and by then the shipper and the
        // dashboard have been stopped too.
        //
        // The only case that needs no probe is rebinding the port a managed container
        // ALREADY holds — that is not a conflict, it is the same house. Everything else,
        // including a first deployment and a switch from an external house, is a
        // destination we have not checked. Gating on `managedPort &&` skipped exactly
        // those.
        if (port !== managedPort && await portInUse(port)) {
          console.log(bad(managedPort
            ? `port ${port} is already in use — not moving the house off ${managedPort}.`
            : `port ${port} is already in use — nothing was started or stopped.`));
          console.log('  free that port, or pick another with --house-port.');
          process.exitCode = 2; break;
        }
      }

      // Validation passed. From here the command changes things.
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
      const r = dep.up({ password: pw, port, tag });
      if (!r.ok) { console.log(bad(r.msg)); process.exitCode = 1; break; }
      console.log(ok(`ClickHouse starting via ${r.engine} on ${r.url} (loopback only)`));

      // PERSIST THE CREDENTIAL BEFORE WAITING. The container may initialise the volume
      // and still not answer in time — it crashes and comes back later under
      // `--restart unless-stopped`, the host is loaded, the image is cold. If the only
      // copy of a generated password leaves with this process, the next `deploy --local`
      // finds an initialised volume with nothing to reuse and correctly refuses, and the
      // house that eventually came up is unreachable forever. The image applies the
      // password only at first init, so there is no way back from that.
      if (!reusable) {
        writeEnvFile({ ...priorCfg, url: r.url, user: 'memhouse_root', password: pw });
        console.log(ok(`credential saved to ${ENV_FILE} before waiting — the volume is initialised with it`));
      }

      if (!(await dep.waitReady(r.url))) {
        console.log(bad(`ClickHouse did not answer on ${r.url} — check: ${r.engine} logs ${dep.CONTAINER}`));
        if (!reusable) {
          console.log(`  the credential is already saved in ${ENV_FILE.replace(os.homedir(), '~')}; re-run`);
          console.log('  `memhouse deploy --local` once it is up and it will be reused, not regenerated.');
        }
        process.exitCode = 1; break;
      }
      console.log(ok('ClickHouse ready'));
      // A ROOTLESS container lives in the user's systemd slice, and that slice is torn
      // down at logout unless lingering is enabled — the container takes a SIGTERM and
      // the house goes down with it. Measured on a testbed VM: `deploy --local` over ssh
      // shipped 211 sessions, the ssh session ended, and the container was
      // `Exited (143)` twenty seconds later with `Linger=no`. The volume survives, so
      // nothing is lost, but the house is gone with no explanation anywhere.
      //
      // `service install` already detects exactly this for its own unit. The container
      // needs the same check, and podman is the case that matters: it is rootless by
      // default, where docker is conventionally a system daemon that outlives logout
      // (rootless docker has the same exposure, but is the deliberate minority).
      if (process.platform === 'linux' && r.engine === 'podman') {
        let lingering = true;
        try { lingering = require(path.join(REPO_ROOT, 'mem-house', 'service.js')).lingerEnabled(); } catch { /* assume fine */ }
        if (!lingering) {
          console.log(warn('rootless podman: this container stops when you log out (lingering is off).'));
          console.log(`     loginctl enable-linger ${os.userInfo().username}`);
          console.log('  Until then, after a logout: memhouse deploy --local   (the data volume persists)');
        }
      }
      flags.url = r.url; flags.user = 'memhouse_root'; flags.password = pw;
      flags.db = targetDb;
      flags.yes = true;
      process.exitCode = await cmdInstall({ interactive: false });
      break;
    }
    case 'service': {
      const svc = require(path.join(REPO_ROOT, 'mem-house', 'service.js'));
      const sub = positional[0] || 'status';
      if (sub === 'install') {
        // Ask what can be asked before killing the daemon this is taking over from. A
        // failed install used to leave the machine with no shipper for a condition that
        // was knowable up front.
        const pre = svc.preflight({ envFile: ENV_FILE });
        if (!pre.ok) { console.log(bad(pre.msg)); process.exitCode = 1; break; }
        // The service supersedes the pidfile daemons, and they are not merely redundant:
        // the shim binds a fixed port, so leaving the detached one alive makes the new
        // unit fail with EADDRINUSE and flap under Restart=on-failure. Hand over rather
        // than run both. The dashboard is not service-managed, so it is left alone.
        for (const name of ['shipper']) {
          const pid = pidOf(name);
          if (!pid) continue;
          try { process.kill(pid, 'SIGTERM'); console.log(ok(`${name} daemon stopped — the service takes it over (pid ${pid})`)); } catch { /* raced */ }
          try { fs.unlinkSync(path.join(RUN_DIR, `${name}.pid`)); } catch { /* absent */ }
        }
        const r = svc.install({
          shipJs: SHIP_JS, envFile: ENV_FILE, logDir: LOG_DIR, interval: flags.interval || 300,
          // Where this install lives. The env file records the connection, not the home
          // that contains it, and an adapter override may hang off the home.
          home: HOME_DIR,
        });
        if (!r.ok) { console.log(bad(r.msg)); process.exitCode = 1; break; }
        console.log(ok(`service installed (${r.kind}): ${r.path}`));
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
        for (const f of st.legacy || []) console.log(warn(`stale unit from an older version: ${f} — remove with: memhouse service uninstall`));
      }
      break;
    }
    case 'uninstall': cmdUninstall(); break;
    default:
      console.error(`unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 2;
  }
})().catch((e) => { console.error(bad(e.message)); process.exit(1); });
