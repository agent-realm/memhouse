#!/usr/bin/env node
// memhouse — the memhouse CLI. One command to install, ship, serve, and query
// agent conversation memory (see memhouse/DESIGN.md).
//
// Thin orchestrator: heavy operations run the existing entrypoints
// (memhouse/shipper/ship.js, memhouse/server/server.js) as children with the
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
const SHIP_JS = path.join(REPO_ROOT, 'memhouse', 'shipper', 'ship.js');
const SERVER_JS = path.join(REPO_ROOT, 'memhouse', 'server', 'server.js');
const DELIVERY = path.join(REPO_ROOT, 'memhouse', 'delivery');
const PKG = require(path.join(REPO_ROOT, 'package.json'));
const {
  roomNames, physicalRoom, ROOM_TYPES, MEMBER_PIN, installCommand, keyProblem,
  SCHEMA_VERSION, MIN_WRITER_SCHEMA, MIGRATIONS, META_TYPES, createStatement,
} = require(path.join(REPO_ROOT, 'memhouse', 'house', 'house'));
const envfile = require(path.join(REPO_ROOT, 'memhouse', 'envfile'));
const { consumeSecretChunk } = require(path.join(REPO_ROOT, 'memhouse', 'secret-input'));
const { capabilitiesFrom } = require(path.join(REPO_ROOT, 'memhouse', 'capabilities'));
const { unknownFlags, allowedFlags, suggestFlag } = require(path.join(REPO_ROOT, 'memhouse', 'flags'));

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

// Unknown flags stop the run — see memhouse/flags.js for why a shrug is not enough.
(() => {
  const bad = unknownFlags(cmd, flags);
  if (!bad.length) return;
  const allowed = allowedFlags(cmd);
  for (const f of bad) {
    const hint = suggestFlag(f, allowed);
    console.error(`memhouse: unknown option --${f}${hint ? `  (did you mean --${hint}?)` : ''}`);
  }
  const list = [...allowed].sort().map((f) => `--${f}`).join(' ');
  console.error(`  ${cmd || 'memhouse'} takes: ${list || '(no options)'}`);
  console.error('  Nothing ran. A flag that is ignored rather than refused is how a --dry-run typo');
  console.error('  becomes a real migration.');
  process.exit(2);
})();

let ONBOARDING = false;
let _inviteFileToShred = null;
let _inviteWantsRotate = false;

// ── config ──────────────────────────────────────────────────────────────────────
function readEnvFile() {
  try { return envfile.parse(fs.readFileSync(ENV_FILE, 'utf-8')); } catch { return {}; }
}

function resolveConfig() {
  const file = readEnvFile();
  const pick = (flag, env, dflt) => flags[flag] !== undefined && flags[flag] !== true
    ? flags[flag] : (process.env[env] ?? file[env] ?? dflt);
  const stated = (flag, env) => (flags[flag] !== undefined && flags[flag] !== true)
    || process.env[env] !== undefined || file[env] !== undefined;
  return {
    url: pick('url', 'MEMHOUSE_URL', 'http://localhost:8123'),
    user: pick('user', 'MEMHOUSE_USER', 'memhouse_root'),
    password: pick('password', 'MEMHOUSE_PASSWORD', ''),
    // The house defaults to the USER'S OWN NAME (`polat` ships into `polat.messages`),
    // because a house is a database and the natural first house is your own. Any name
    // works — user 'alice' with house 'default' is a supported pairing.
    // ONE house name unless somebody has a reason. The member's rooms are named for them
    // inside it, so nothing about the database has to be chosen at install time.
    db: pick('db', 'MEMHOUSE_DB', 'mem'),
    port: pick('port', 'MEMHOUSE_PORT', '4640'),
    // The admin credential, when this install keeps one beside its member credential — a
    // `deploy --local` house is administered by the same person who ships into it, so
    // invite/members need no --admin-* flags. Absent on an invited member's machine, and
    // nothing here invents one.
    adminUser: pick('admin-user', 'MEMHOUSE_ADMIN_USER', ''),
    adminPassword: pick('admin-password', 'MEMHOUSE_ADMIN_PASSWORD', ''),
    // Did anything actually SAY which house this is, or are the values above just the
    // defaults? The defaults are not neutral — localhost:8123 as memhouse_root is a real
    // house on a lot of machines, usually the pilot's own. An agent whose config went
    // missing (a temp HOME, a deleted env file, a service running as another user) would
    // otherwise connect there and read or write someone else's memory, silently and with
    // a plausible-looking result. Commands that expect YOUR house call requireConfig().
    stated: stated('url', 'MEMHOUSE_URL') || stated('user', 'MEMHOUSE_USER'),
  };
}

// Refuse to fall back to the built-in defaults. `install`, `deploy`, `discover`,
// `doctor` and `prompt` are exempt by design — they exist precisely for the state where
// there is no config yet, and doctor probes localhost on purpose.
function requireConfig(cfg, what) {
  if (cfg.stated) return cfg;
  if (JSON_OUT) {
    // A --json caller gets JSON even when refused. Prose on stderr and an empty stdout is
    // an unparseable answer to a machine-readable request.
    console.log(JSON.stringify({
      error: 'no_config', command: what, env_file: ENV_FILE, home: HOME_DIR,
      message: `no house configured, so ${what} has nothing to talk to`,
      fix: ['memhouse install --url … --user … --password …', 'memhouse onboard'],
    }, null, 2));
    process.exit(2);
  }
  console.error(`memhouse: no house configured, so ${what} has nothing to talk to.`);
  console.error(`  Nothing was read from ${ENV_FILE.replace(os.homedir(), '~')} and no MEMHOUSE_URL/MEMHOUSE_USER is set.`);
  console.error('  Rather than guess http://localhost:8123 as memhouse_root — which on many');
  console.error('  machines is a real house belonging to someone else — this stops here.');
  console.error('  Fix it with one of:');
  console.error('     memhouse install --url … --user … --password …   point at a house you have');
  console.error('     memhouse onboard                                 set one up from scratch');
  console.error('     MEMHOUSE_URL=… MEMHOUSE_USER=… memhouse …        state it for this run');
  console.error(`  If your config lives elsewhere, set MEMHOUSE_HOME (currently ${HOME_DIR.replace(os.homedir(), '~')}).`);
  process.exit(2);
}

function childEnv(cfg, override = {}) {
  return {
    ...process.env,
    // Set only by the install path, which prints its own refusal for this case.
    ...(cfg._quietDenied ? { MEMHOUSE_QUIET_DENIED: '1' } : {}),
    MEMHOUSE_URL: cfg.url, MEMHOUSE_USER: cfg.user, MEMHOUSE_PASSWORD: cfg.password,
    MEMHOUSE_DB: cfg.db, MEMHOUSE_PORT: String(cfg.port), MEMHOUSE_HOME: HOME_DIR,
      // environment would write into another member's rooms.
    ...override,
  };
}

function writeEnvFile(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  // Single-quoted values: this file is also sourced by shells (skills/docs use
  // `. ~/.memhouse/env`), so metacharacters in a password must never be bare.
  const sq = envfile.quoteShell;
  const body = [
    '# memhouse connection — written by `memhouse install/setup`',
    `MEMHOUSE_URL=${sq(cfg.url)}`,
    `MEMHOUSE_USER=${sq(cfg.user)}`,
    `MEMHOUSE_PASSWORD=${sq(cfg.password)}`,
    `MEMHOUSE_DB=${sq(cfg.db)}`,
    `MEMHOUSE_PORT=${sq(cfg.port)}`,
    ...(cfg.adminUser ? [
      '# The admin credential for this house — present because this machine administers it',
      '# (deploy --local, or an operator install). invite/members use it; nothing else does.',
      `MEMHOUSE_ADMIN_USER=${sq(cfg.adminUser)}`,
      `MEMHOUSE_ADMIN_PASSWORD=${sq(cfg.adminPassword || '')}`,
    ] : []),
    '',
  ].join('\n');
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
}

// ── ClickHouse over HTTP (small read-only queries; heavy ops go via ship.js) ───
async function ch(cfg, sql, { database = cfg.db, settings = null, timeout = 30000 } = {}) {
  // Both settings, always: `final` collapses ReplacingMergeTree versions, and
  // `join_use_nulls` is what the session rollup's coalesce depends on now that it is a
  // saved query rather than a view carrying its own SETTINGS clause.
  const params = new URLSearchParams({ final: '1', join_use_nulls: '1' });
  for (const [k, v] of Object.entries(settings || {})) params.set(k, String(v));
  if (database) params.set('database', database);
  // Most CLI queries are small reads and 30s is plenty; a `relocate` copy of a whole room
  // runs server-side but the HTTP response only returns when it FINISHES, so a large
  // transfer needs a far longer ceiling — passed per call rather than raised for all.
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/?${params}`, {
    method: 'POST',
    body: sql,
    headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64') },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split('\n')[0]);
  return text.trim();
}
/**
 * The grant lines ClickHouse reports for a user, as strings.
 *
 * Never pass a FORMAT here — chRows appends its own, and a statement carrying two is a
 * syntax error. That mistake once read as "no grants at all", which refused every
 * credential including a genuine superuser, and it was invisible on any machine whose
 * own credential is an ordinary member.
 *
 * Unreadable grants come back as [] rather than throwing: a credential that cannot read
 * its own grants is, for every decision made from this, simply not an administrator.
 */
async function readGrants(cfg, user) {
  try {
    const rows = await chRows(cfg, `SHOW GRANTS FOR ${user}`, { database: '' });
    return rows.map((r) => Object.values(r).join(' '));
  } catch { return []; }
}

async function chRows(cfg, sql, opts) {
  const text = await ch(cfg, sql + ' FORMAT JSONEachRow', opts);
  return text ? text.split('\n').map((l) => JSON.parse(l)) : [];
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
    const svc = require(path.join(REPO_ROOT, 'memhouse', 'service.js'));
    const st = svc.status();
    if (st.installed) return { running: st.running, via: `service (${st.kind})` };
  } catch { /* no service integration on this platform */ }
  return { running: false, via: null };
}

// Room routing for the CLI's own queries. The shipper and dashboard resolve rooms through
// @clickhouse/client; the CLI speaks raw HTTP, so it asks the same question over its own
// transport and builds the names with the same shared function.
// Keyed by the connection the answer belongs to, NOT a single slot. One slot was right
// only while a process talked to one house as one member; `relocate` talks to two, and the
// second call would have been handed the first house's names — silently, in the one
// command whose whole job is moving rooms between houses.
const _rooms = new Map();
async function roomsFor(cfg) {
  const key = JSON.stringify([cfg.url, cfg.user, cfg.db]);
  if (_rooms.has(key)) return _rooms.get(key);
  const rows = await chRows(cfg, 'SELECT currentUser() AS u');
  const member = rows[0] && rows[0].u;
  if (!member) throw new Error('could not determine currentUser() for room resolution');
  const r = roomNames(member);
  _rooms.set(key, r);
  return r;
}

// ── small helpers ───────────────────────────────────────────────────────────────
const ok = (s) => `  \x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `  \x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `  \x1b[33m•\x1b[0m ${s}`;

function run(script, args, cfg, envOverride = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    env: childEnv(cfg, envOverride), stdio: 'inherit', encoding: 'utf-8',
  });
  return r.status ?? 1;
}

async function ask(question, dflt) {
  const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(dflt !== undefined ? `${question} [${dflt}]: ` : `${question}: `)).trim();
  rl.close();
  return a || dflt || '';
}

// undici reports every transport failure as the string 'fetch failed' and hides the real
// reason in .cause. `✗ not connected: fetch failed` names neither the host nor the problem,
// while `ship` prints ECONNREFUSED for the identical condition — the three commands
// disagreed about the same event.
function netReason(e) {
  const cause = e && e.cause;
  const inner = cause && (cause.message || cause.code);
  const codes = cause && Array.isArray(cause.errors)
    ? cause.errors.map((x) => x && (x.code || x.message)).filter(Boolean) : [];
  const detail = inner || codes[0];
  if (!detail) return e && e.message ? e.message : String(e);
  return e.message && e.message !== detail ? `${e.message} (${detail})` : detail;
}

// Read without echoing. `onboard` and `setup` both prompt for the house password and
// printed it back on the terminal — in a wizard whose whole audience is someone typing a
// credential in front of whoever is in the room.
function askSecret(label, dflt = '') {
  if (!process.stdin.isTTY) return ask(label, dflt);
  return new Promise((resolve) => {
    process.stdout.write(`${label}${dflt ? ` [${'*'.repeat(Math.min(dflt.length, 8))}]` : ''}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf-8');
    let buf = '';
    // One 'data' event carries a CHUNK, not a keystroke — see memhouse/secret-input.js
    // for why that distinction is load-bearing and what it broke.
    let done = false;
    const onData = (chunk) => {
      if (done) return;
      const r = consumeSecretChunk(buf, chunk);
      buf = r.buf;
      if (r.interrupted) { process.stdout.write('\n'); process.exit(130); }
      if (!r.done) return;
      done = true;
      stdin.removeListener('data', onData);
      stdin.setRawMode(!!wasRaw); stdin.pause();
      process.stdout.write('\n');
      resolve(buf || dflt);
    };
    stdin.on('data', onData);
  });
}

function pidOf(name) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(RUN_DIR, name + '.pid'), 'utf-8'), 10);
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

// Signal 0 tests for existence without delivering anything.
// The port the RUNNING dashboard was started with, not the one currently configured.
function runningPort(cfg) {
  try { return fs.readFileSync(path.join(RUN_DIR, 'dashboard.port'), 'utf-8').trim() || cfg.port; }
  catch { return cfg.port; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
                                  --env FILE installs from an invite file (see: invite)
             invite <name>        mint a member and write the env file their install needs
                                  (--url [--db NAME] [--out FILE]; --admin-user and
                                  --admin-password only if this install keeps no admin
                                  credential). They get rooms named for them, <db>.<name>_*,
                                  and one grant on exactly those. Refuses a name whose rooms
                                  already hold messages; --adopt takes them over (same
                                  person, new credential). Not an admin? --print-sql prints
                                  the plan to hand to whoever is.
             passwd               rotate this member's password + rewrite the env file
                                  (admin-assisted: --admin-user --admin-password)
             setup                (re)write the connection config only (--yes = no prompts)
             discover             read-only preflight: editors, sessions, reachable ClickHouses
             uninstall            stop daemons + service, clear runtime state (asks; --yes).
                                  KEEPS the config and this machine's host identity
                                  --credentials    also forget the house and its password
                                  --full-removal   all of ${HOME_DIR.replace(os.homedir(), '~')}, identity included
                                  no tier touches the house data
             nightly              build an installable version-stamped tarball from this
                                  checkout, publishing nothing [--out DIR]
             update               upgrade, restart the daemons, migrate the house if it
                                  needs it (asks; --migrate runs unasked; --no-install
                                  skips npm when you already upgraded by hand)
                                  (--check to compare versions and change nothing)
             reset                clear the shipper's rows and re-ship everything (--yes to skip confirm)
                                  imported rows are kept; --all-origins removes those too

Data         ship                 one incremental pass (--full | --loop [sec])
             stats                per-source session/message/token counts
             search <terms…>      full-text search across all sessions
             resume <session-id>  print the command that reopens that session in its editor
             sessions-query       print the session rollup SQL for this credential
             rooms                what your rooms are actually called (--json)
             members              who is in a house and what each can reach (--db, admin)
             start | stop |       shipper loop + dashboard as background daemons
             share <user>         let someone read this house (--only project=… |
                                  session=… | host=… | source=… | folder=… | since=… |
                                  until=… scopes it with row policies; --revoke
                                  withdraws and drops them; --list shows who)
             whoami               which credential is in play, and what it may do
                                  (--json; --admin reads MEMHOUSE_ADMIN_*)
             status               daemons, connection, counts, freshness (--json)
             doctor               diagnose the whole pipeline

Agents       plugins              list | install claude [--target DIR] | remove claude
                                  acts on EVERY Claude config dir found (~/.claude,
                                  CLAUDE_CONFIG_DIR, ~/.claude-playbooks/*), all
                                  selected by default; --yes takes them all unasked
             prompt               print the memory system-prompt snippet
             prompt --install     print an install prompt for an agent, with this
                                  machine's state and the one route that applies

House        deploy --local       run ClickHouse in docker/podman, then install
             deploy --down        remove the local house (container + volume)
                                  [--house-port N] [--tag 25.11]  (--port is the dashboard)
             migrate              run every migration this house still needs
                                  [--dry-run] [--yes]  (copy + atomic swap; deletes nothing)
             migrate-rooms        the same, scoped to the rooms
             relocate --to URL    copy this whole house to a NEW ClickHouse (server-to-
                                  server) and repoint this install — the shipper does NOT
                                  re-ingest. [--to-user --to-password --to-db]
                                  [--from-native-host H] [--from-native-port N]
                                  [--insecure-native] [--keep-shipper] [--dry-run] [--yes].
                                  Source untouched.
             service install      run the shipper as a user service (systemd / launchd)
             service stop | start | restart | uninstall | status

Config: flags > MEMHOUSE_* env > ${ENV_FILE.replace(os.homedir(), '~')} > defaults.
Engine: MEMHOUSE_ENGINE pins docker or podman when both are installed and one cannot answer.
`;

// A skipped adapter and an editor the user does not have look identical — both
// contribute zero sessions. Say which happened.
//
// There was a second branch here for the one cause that hit five adapters at once: a
// missing better-sqlite3 native binding, fixable only by reinstalling with a flag. With
// SQLite now inside Node there is nothing to install and nothing to advise — every
// remaining failure is one adapter's own store, and its own message is the whole story.
function printAdapterErrors(errors) {
  if (!errors || errors.length === 0) return;
  for (const e of errors) console.log(warn(`${e.source.padEnd(16)} skipped: ${e.message}`));
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
  for (const e of out.editors) console.log(ok(`${e.source.padEnd(16)} ${e.sessions} session${e.sessions === 1 ? '' : 's'}`));
  printAdapterErrors(out.adapterErrors);
  console.log('\nClickHouse endpoints:');
  for (const p of out.clickhouse) {
    if (!p.reachable) console.log(bad(`${p.url} — unreachable`));
    else if (p.auth) console.log(warn(`${p.url} — reachable, credentials needed`));
    else console.log(ok(`${p.url} — v${p.version}${p.hasHouse ? ', house present' : ''}${p.kernel ? ', KERNEL detected' : ''}`));
  }
  console.log('');
  // This banner is shared with `onboard`, which was therefore telling the user, mid-wizard,
  // to run the wizard they are already inside.
  console.log(out.config ? ok(`config: ${out.config}`) : warn(ONBOARDING ? 'no config yet — setting one up now' : 'no config yet — run: memhouse install (or onboard)'));
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

1. \`${installCommand()}\`
   The flag is not optional — five adapters (cursor, zed, opencode, goose, antigravity)
   read SQLite stores and silently drop out without the native build. (windsurf needs it
   too but is excluded upstream, so discover names five; the two numbers agree.)
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

1. \`${installCommand()}\`
   The flag is not optional — five adapters read SQLite stores and silently drop out
   without the native build.
2. \`memhouse deploy --local\`
   This starts a loopback-only ClickHouse, generates a credential, installs, creates the
   user's rooms and runs the first ship. One command, no questions.
3. \`memhouse start\`.

${process.platform === 'linux' && engines.includes('podman')
    ? 'On Linux with rootless podman the container MAY stop at logout — it depends on the\ndistro (Ubuntu 24.04 keeps it). If memhouse warns about this, run what it prints\n(`loginctl enable-linger <user>`) and tell the user why it matters.' : ''}`;
  } else {
    plan = `There is no ClickHouse reachable and no container engine to run one with. You
cannot finish this install alone — say so rather than improvising.

Tell the user they need one of:
- a ClickHouse they already run (Cloud, a server, a kernel house) plus its credentials;
- docker or podman installed, after which \`memhouse deploy --local\` does everything.

You can still do the harmless half now: \`${installCommand()}\`,
then \`memhouse discover\` to show them what would be shipped once a house exists.`;
  }

  const out = body
    .replaceAll('{{VERSION}}', PKG.version)
    // The install prompt is otherwise entirely per-machine — db, url, editors, engines —
    // and then told the agent the config lands at a hardcoded ~/.memhouse/env. `prompt`
    // without --install already got this right; the fix had landed in one of the two.
    .replaceAll('{{ENV_FILE}}', ENV_FILE)
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
  try { return require(path.join(REPO_ROOT, 'memhouse', 'deploy.js')).availableEngines() || []; }
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
  // The SAME plan adminBootstrap executes, rendered. Not a second description of it.
  const { plan, render } = require(path.join(REPO_ROOT, 'memhouse', 'provision'));
  return render(plan({ db, member, password }), { db, member });
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
  // What this run has already changed on the server, for an honest failure message.
  let createdUser = null;
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

  // 2. the user. A shared house makes an existing user unremarkable — rows are told apart
  // by the server-stamped user_id, so "the handle is taken" hands nobody anything. What
  // still matters is proof: connecting AS the member below is what validates whichever
  // password is in play, existing user or fresh one.
  let exists;
  try {
    exists = (await chRows(adminCfg, `SELECT name FROM system.users WHERE name = '${admin.member}'`, { database: '' })).length > 0;
  } catch (e) {
    if (/Not enough privileges|ACCESS_DENIED|system\.users/i.test(e.message || '')) {
      console.log(bad(`'${admin.user}' is not an admin of this house — it cannot read system.users, so it cannot provision a member`));
      console.log('  Joining a house is a user and one grant, for whoever owns it — print them with:');
      console.log(`     memhouse install --print-sql --member ${admin.member} --db ${cfg.db}`);
      console.log('  If you already HAVE a credential on this house, you do not need admin:');
      console.log(`     memhouse install --url ${adminCfg.url} --user ${admin.member} --password …`);
      return null;
    }
    throw e;
  }
  let password = flags['member-password'] || null;
  if (exists) {
    if (!password) {
      console.log(bad(`ClickHouse user '${admin.member}' already exists — pass --member-password to install as them.`));
      console.log(`  Or pick another handle:  --member <name>`);
      return null;
    }
    try { await ch({ ...cfg, user: admin.member, password }, 'SELECT 1', { database: '' }); }
    catch { console.log(bad(`'${admin.member}' did not authenticate with that password`)); return null; }
    console.log(ok(`using the existing ClickHouse user '${admin.member}' (password verified)`));
  } else {
    if (!password) {
      password = generatePassword();
      // For a local install the password must be SHOWN — it is the user's only copy. For
      // an invite it must NOT: the caller writes it to the credential file, and printing
      // it here would land it in the terminal and, via /mem:access, in a transcript
      // memhouse itself ships. admin.quiet is the invite path.
      if (!admin.quiet) {
        console.log('');
        console.log(`  password for '${admin.member}':  ${password}`);
        console.log(`  Shown once. It goes into ${ENV_FILE}; to change it later:`);
        console.log(`     ALTER USER ${admin.member} IDENTIFIED BY '…'   then: memhouse setup --password …`);
        console.log('');
      }
    }
    try { await q(`CREATE USER ${admin.member} IDENTIFIED BY '${password.replace(/'/g, "\\'")}'`, { database: '' }); }
    catch (e) {
      console.log(bad(`could not create user '${admin.member}': ${e.message}`));
      // The stored-credential invite path chose this credential from a cheap
      // system.users read-probe, which does not prove CREATE USER rights. If that is why
      // we are here, name the real fix rather than leaving a raw ACCESS_DENIED.
      if (admin.quiet && /Not enough privileges|ACCESS_DENIED/i.test(e.message || '')) {
        console.log('  your configured credential can read users but not create them —');
        console.log('  pass an admin that can:  memhouse invite … --admin-user <a> --admin-password <p>');
      }
      return null;
    }
    console.log(ok(`created ClickHouse user '${admin.member}'`));
    createdUser = admin.member;
  }

  // 3. the grant and the pin. GRANT ALL on the house is the whole tenancy model: it
  // reaches nothing outside the database, and it is what lets the member's own shipper
  // create and evolve the rooms (--ensure-schema below).
  try {
    // ALL, WITH GRANT OPTION: the database is theirs, so they may do anything with their
    // own data AND hand any of it on. /mem:access still opens only a read-only window (it
    // grants SELECT), but the owner is not boxed into read-only sharing of their own house.
    // Scoped to their db: the grant option reaches nothing outside it, and no CREATE USER
    // comes with it, so a member still cannot mint accounts or touch another house.
    // The user was created or verified above, so the plan runs with password: null and its
    // CREATE USER is omitted; the database was handled at the top. Everything else is
    // executed as written — what a DBA gets from --print-sql and what happens here are the
    // same statements by construction.
    const { plan } = require(path.join(REPO_ROOT, 'memhouse', 'provision'));
    const skipped = [];
    for (const step of plan({ db: cfg.db, member: admin.member, password: null })) {
      if (step.sql.startsWith('CREATE DATABASE')) continue;
      try { await q(step.sql, { database: '' }); }
      catch (e) {
        if (!step.optional) throw e;
        skipped.push(step.why.replace(/`/g, ''));
      }
    }
    console.log(ok(`granted '${admin.member}' ${cfg.db}.${admin.member}_* — their rooms and nothing else; async_insert pinned`));
    for (const w of skipped) console.log(warn(`skipped (needs ACCESS MANAGEMENT): ${w}`));
  } catch (e) {
    console.log(bad(`could not grant the house to '${admin.member}': ${e.message}`));
    if (createdUser) {
      console.log(`  ClickHouse user '${createdUser}' WAS created before this failed.`);
      console.log(`  Continue once fixed:  memhouse install --member ${createdUser} --member-password '<the password above>' …`);
      console.log(`  Or undo it as the admin:  DROP USER ${createdUser}`);
    } else {
      console.log('  nothing was written');
    }
    return null;
  }

  // The step that makes this trustworthy: stop being admin, and prove the credential we
  // are about to persist can build and reach the rooms itself.
  // The proof below runs the real shipper as the new member; it creates their rooms itself.
  const memberCfg = { ...cfg, user: admin.member, password };
  // An invite must not mint THIS machine's host identity, nor record the invitee as a
  // <invitee>@<inviter-host> writer in a house the inviter will never ship to. Run the
  // schema-build proof against a throwaway MEMHOUSE_HOME so host.json lands there and is
  // discarded — the invitee mints their real identity on their own first ship.
  const proofEnv = admin.quiet
    ? { MEMHOUSE_HOME: fs.mkdtempSync(path.join(require('os').tmpdir(), 'mh-invite-')), MEMHOUSE_NO_RECORD: '1' }
    : {};
  if (run(SHIP_JS, ['--ensure-schema'], memberCfg, proofEnv) !== 0) {
    console.log(bad(`'${admin.member}' could not create the rooms in '${cfg.db}' — nothing written to disk`));
    return null;
  }
  try {
    const want = roomNames(admin.member);
    const names = ROOM_TYPES.map((t) => `'${want.physical[t]}'`).join(',');
    const seen = await chRows(memberCfg, `SELECT count() AS n FROM system.tables WHERE database = '${cfg.db}' AND name IN (${names})`, { database: '' });
    if (Number(seen[0]?.n) !== 3) { console.log(bad(`'${admin.member}' cannot see the three rooms — nothing written`)); return null; }
  } catch (e) { console.log(bad(`'${admin.member}' could not connect after provisioning: ${e.message}`)); return null; }
  // Whether the admin credential is kept is the CALLER's business: an operator's own
  // install keeps it in the env file beside the member's; an invitee's file never carries it.
  console.log(ok(`verified as '${admin.member}' with the member credential`));
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
  // Reserved names are refused however they arrive. The check used to live only in
  // suggestMember(), i.e. only on the handle DERIVED from $HOME — so `HOME=/root` was
  // refused while an explicit `--member root` sailed through and created a ClickHouse
  // user named root with ALL on its rooms. A guard that a flag walks around is not a
  // guard; the reason it exists does not change with how the name was typed.
  //
  // `default` is deliberately NOT on this list. It is ClickHouse's own catch-all user and
  // a poor choice of member, but it is a real one that existing houses are built on —
  // refusing it would lock those pilots out of their own install.
  if (member.toLowerCase() === 'root') {
    console.log(bad(`'${member}' cannot be a member — it is a container artefact, not a person.`));
    console.log('  Pick a name that identifies a person or a machine: memhouse install --member <name>');
    return null;
  }
  if (!flags.member && s.changed) console.log(warn(`member handle '${s.changed}' sanitized to '${member}' — pass --member to choose another`));
  return member;
}

// Do the rooms' sorting keys match what the shipper will accept? Returns a description of
// what is wrong, or null. The keys themselves and what each column buys live on ROOM_KEYS
// in memhouse/house/house.js — one definition, checked identically here and in the shipper.
async function sortingKeyProblem(cfg) {
  try {
    const rooms = await roomsFor(cfg);
    const wrong = [];
    for (const t of ROOM_TYPES) {
      const r = await chRows(cfg, `SELECT sorting_key AS k FROM system.tables WHERE database = '${cfg.db}' AND name = '${rooms[`${t}_raw`]}'`, { database: '' });
      const key = r[0]?.k;
      if (!key) continue;
      const problem = keyProblem(t, key);
      if (problem) wrong.push(`${rooms[`${t}_raw`]} ${problem}`);
    }
    return wrong.length ? wrong.join('; ') : null;
  } catch { return null; }  // unreachable house is a different check's problem
}

// Start the shipper as a BACKGROUND daemon instead of blocking install on a full first
// pass. A fresh member's first ship loads the ENTIRE local backlog — yigido's was 558
// sessions / 224s — and running it synchronously (the old `run(SHIP_JS)`) made `install`
// sit silent for minutes and read as hung. Detached, install returns at once, the history
// loads in the background, and the loop keeps shipping. Mirrors cmdStart's shipper daemon,
// and defers to an installed service rather than running a second shipper beside it.
//
// Must be called AFTER finishInvite: rotation rewrites the env file, so the daemon has to
// be spawned from a RE-READ config (resolveConfig()) or it would carry the old password.
function startShipperBackground(cfg) {
  let svc = { installed: false, running: false };
  try { svc = require(path.join(REPO_ROOT, 'memhouse', 'service.js')).status(); } catch { /* unsupported platform */ }
  if (svc.installed) {
    console.log(svc.running
      ? ok('shipping runs under the installed service — nothing to start')
      : warn('a shipper service is installed but stopped — start it:  memhouse service start'));
    return;
  }
  const existing = pidOf('shipper');
  if (existing) { console.log(ok(`shipper already running in the background (pid ${existing})`)); return; }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, 'shipper.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [SHIP_JS, '--loop', String(flags.interval || 300)], {
    env: childEnv(cfg), detached: true, stdio: ['ignore', log, log],
  });
  fs.writeFileSync(path.join(RUN_DIR, 'shipper.pid'), String(child.pid));
  child.unref();
  console.log(ok(`shipper started in the background (pid ${child.pid}) — loading your history now`));
  console.log('  a large first ship can take a few minutes; watch it finish with:  memhouse status');
  console.log('  dashboard (browse / search / analyze):  memhouse start');
}

async function cmdInstall({ interactive }) {
  // --env <file>: an INVITE intake. The file carries MEMHOUSE_URL/USER/PASSWORD/DB from
  // `memhouse invite` on the admin's machine; loading it into the environment BEFORE
  // resolveConfig makes every value count as stated, and the rest of install runs
  // unchanged — including the existing-config mismatch refusal and the config-last
  // write. Nothing is persisted until the connection and rooms have proved out.
  if (flags.env && flags.env !== true) {
    let parsed;
    try { parsed = envfile.parse(fs.readFileSync(String(flags.env), 'utf-8')); }
    catch (e) { console.log(bad(`could not read --env ${flags.env}: ${e.message}`)); return 1; }
    const wanted = ['MEMHOUSE_URL', 'MEMHOUSE_USER', 'MEMHOUSE_PASSWORD', 'MEMHOUSE_DB'];
    // Password REQUIRED too — an edited/truncated invite that drops it would otherwise let
    // resolveConfig fall back to an ambient or existing-config password, "succeeding" on
    // this machine with a file that cannot authenticate on the invitee's.
    const missing = wanted.filter((k) => !parsed[k]);
    if (missing.length) { console.log(bad(`--env ${flags.env} is missing ${missing.join(', ')} — not a complete invite file?`)); return 1; }
    // Clear ambient MEMHOUSE_* so ONLY the file speaks (exported vars normally win over the
    // file; an invite intake is the one place they must not).
    for (const k of ['MEMHOUSE_URL', 'MEMHOUSE_USER', 'MEMHOUSE_PASSWORD', 'MEMHOUSE_DB', 'MEMHOUSE_PORT']) delete process.env[k];
    for (const k of wanted) process.env[k] = parsed[k];
    console.log(ok(`using the invite file ${String(flags.env)} (nothing persisted until the install proves out)`));
    _inviteFileToShred = path.resolve(String(flags.env));
    _inviteWantsRotate = parsed.MEMHOUSE_INVITE === '1';
  }
  let cfg = resolveConfig();
  const adminUser = flags['admin-user'];

  // The house name is spliced unquoted into CREATE DATABASE and GRANT ALL ON <db>.* —
  // validate it HERE, on every install mode, not only where deploy happens to choose it.
  // Found by the acceptance run, driven end to end: `install --db system` sailed through,
  // granted a member CHECK/SHOW/SELECT/INSERT/ALTER/DROP/TRUNCATE/… ON system.* and
  // created sessions/messages/tool_calls INSIDE the server's system database, exit 0.
  // On a shared or kernel ClickHouse that is a granted-everything-on-system user minted
  // by a memhouse one-liner.
  try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(cfg.db, 'house'); }
  catch (e) { console.log(bad(e.message)); return 1; }

  // Option 1 — print the SQL and stop. For the common case: you have admin on this
  // ClickHouse and would rather run four statements yourself than hand a credential to an
  // installer. Nothing is written and nothing is contacted.
  if (flags['print-sql'] === true) {
    const member = resolveMemberHandle();
    if (!member) return 1;
    const password = flags['member-password'] || generatePassword();
    console.log(memberSql(cfg.db, member, password));
    console.log(`-- Then, once that has run:`);
    // Only echo a URL that was actually STATED. --print-sql is the path where the house is
    // typically someone else's, run by someone else, and cfg.url falls back to
    // http://localhost:8123 — the one address the rest of the product refuses to guess.
    // Handing it back as a copy-paste command carrying a live credential is worse than
    // leaving a placeholder.
    console.log(cfg.stated
      ? `--   memhouse install --url ${cfg.url} --db ${cfg.db} --user ${member} --password '${password}'`
      : `--   memhouse install --url <the house this SQL was run on> --db ${cfg.db} --user ${member} --password '${password}'`);
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
  // BEFORE the env file and BEFORE the ship. INSTALL.md's contract is that the config is
  // written last, "after everything above has proved out", because a config left by a
  // failed install is read as truth by the next command. Placed after the write, a
  // wrong-key house got four green ticks and a persisted config, and `status` then added
  // five more on a house that can never be shipped to.
  const keyProblem = await sortingKeyProblem(cfg);
  if (keyProblem) {
    console.log(bad(`the rooms are here, but their sorting keys are wrong: ${keyProblem}`));
    console.log('  a ship pass would corrupt them, so `memhouse ship` will refuse.');
    // migrate-rooms, not "rebuild by hand from the template" — this advice predated the
    // command and survived it, so an UPGRADING pilot (the main person who ever sees this)
    // was pointed at a manual rebuild that the tool now does for them, atomically and
    // without deleting anything.
    // With the SAME connection flags — no config was written (see below), so a bare
    // `memhouse migrate-rooms` here would answer "no house configured" and strand the
    // pilot in a loop between two refusals.
    console.log('  rebuild them (a copy + swap; nothing is deleted), then install again:');
    console.log(`     memhouse migrate-rooms --url ${cfg.url} --db ${cfg.db} --user ${cfg.user} --password …`);
    console.log('  no config was written — nothing here reads as installed.');
    return 1;
  }
    writeEnvFile(cfg);
    console.log(ok(`config written: ${ENV_FILE}`));
    // Same as the member path below: the identity is minted where the machine joins.
    {
      const me = require(path.join(REPO_ROOT, 'memhouse', 'host.js')).identity(HOME_DIR);
      console.log(ok(`host identity: ${me.id}`));
      console.log(`  every machine you install as '${cfg.user}' writes into the same rooms; this is what tells them apart`);
    }
    console.log(ok('installed'));
    console.log('  adding a housemate later — the admin credential is in your env file, so no flags:');
    console.log(`     memhouse invite <name> --url ${cfg.url}`);
    printGettingStarted(cfg);
    await finishInvite(cfg);
    // The first ship loads the whole backlog; do it in the background so install returns
    // now. resolveConfig() re-reads the env file finishInvite may have just rotated.
    if (flags['no-ship'] !== true) startShipperBackground(resolveConfig());
    return 0;
  }

  // Flags that only mean something on the admin branch. Silently ignoring them is how a
  // run with --adopt-user --member bob --member-password … and no --admin-user ended up
  // authenticating as memhouse_root instead: the three flags did nothing, --yes satisfied
  // haveAll so no prompt asked who you were, and resolveConfig's default was used AS A
  // CREDENTIAL. Refuse rather than do something else silently.
  const adminOnly = ['member', 'member-password'].filter((k) => flags[k] !== undefined);
  if (!adminUser && adminOnly.length) {
    console.log(bad(`--${adminOnly.join(', --')} ${adminOnly.length > 1 ? 'are' : 'is'} only read with --admin-user`));
    console.log('  Those flags provision a member, which needs house admin. Without them this');
    console.log('  command connects as an EXISTING member instead:');
    console.log('     memhouse install --url … --user <member> --password …');
    console.log('  That is also the "same person on a new machine" path — no admin needed.');
    return 1;
  }

  // An invite file answers every question an interactive install would ask — prompting
  // after --env re-asks what the file already stated (measured: it prompted for the URL
  // and an EOF'd stdin sailed through the defaults).
  const haveAll = flags.yes === true || (flags.url && flags.user !== undefined)
    || (flags.env && flags.env !== true);
  // --yes must not turn "unanswered" into "the default". Everywhere else in the product a
  // missing house is refused; here it was authenticated with.
  if (haveAll && !cfg.stated) {
    console.log(bad('no house given: --url and --user are required with --yes'));
    console.log('  memhouse will not fall back to http://localhost:8123 as memhouse_root —');
    console.log('  on many machines that is a real house belonging to someone else.');
    console.log('  No ClickHouse yet?  memhouse deploy --local --house-port <port>');
    return 2;  // same code as every other no-config refusal
  }
  if (interactive || !haveAll) {
    // Offer a default only where one was actually STATED. Otherwise this prompt said
    // "Enter keeps the default" over `http://localhost:8123` / `memhouse_root` — the pair
    // the no-config refusal three commands away declines to guess, while naming this very
    // command as the fix. Pressing Enter is not a decision the user made about which house
    // to use; requiring the answer is.
    console.log(cfg.stated
      ? 'memhouse connection (Enter keeps the default):'
      : 'memhouse connection (no house is configured yet — these have no defaults):');
    cfg.url = await ask('  ClickHouse URL', cfg.stated ? cfg.url : '');
    cfg.user = await ask('  user', cfg.stated ? cfg.user : '');
    if (!cfg.url || !cfg.user) {
      console.log(bad('a URL and a user are required — memhouse will not pick a house for you'));
      console.log('  no ClickHouse yet?  memhouse deploy --local --house-port <port>');
      return 1;
    }
    cfg.password = await askSecret('  password', cfg.password);
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
  const displaces = Boolean(prior.MEMHOUSE_URL)
    && (!sameEndpoint(prior.MEMHOUSE_URL, cfg.url) || (prior.MEMHOUSE_DB && prior.MEMHOUSE_DB !== cfg.db));
  if (displaces && flags.force !== true) {
    console.log(bad(`${ENV_FILE} already points at ${prior.MEMHOUSE_URL} / ${prior.MEMHOUSE_DB || '?'}`));
    console.log(`  installing over it would leave any running shipper or service on the old house.`);
    console.log('     memhouse setup --url … --db …     (move deliberately)');
    console.log('     memhouse install --force …        (overwrite anyway)');
    return 1;
  }
  if (displaces) {
    // --force used to overwrite the file and say nothing. The password inside is often
    // the ONLY copy — an invited member cannot mint another — so replacing it silently
    // orphans a house that still exists and still costs disk. A drill found this by
    // taking the hatch the refusal above offers: the arriver read "already exists",
    // reached for --force, and destroyed a working credential without being told.
    // `relocate` already keeps the old file for the same operation; so does this now.
    console.log(warn(`replacing the credential for ${prior.MEMHOUSE_USER || '?'}@${prior.MEMHOUSE_URL} (house '${prior.MEMHOUSE_DB || '?'}')`));
    try {
      fs.copyFileSync(ENV_FILE, `${ENV_FILE}.pre-install`);
      console.log(`  previous config kept at ${`${ENV_FILE}.pre-install`.replace(os.homedir(), '~')} — it holds that password`);
    } catch { console.log(warn('  could not keep a copy of the previous config')); }
    console.log('  that house still exists; nothing was deleted from the server.');
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
  const want = ROOM_TYPES.map((t) => r[`${t}_raw`]);
  const present = async () => {
    const list = `'${want.join("','")}'`;
    return (await chRows(cfg, `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN (${list})`, { database: '' })).map((x) => x.name);
  };
  let have = [];
  try { have = await present(); } catch (e) { console.log(bad(`could not list rooms: ${e.message}`)); return 1; }
  if (have.length !== want.length) {
    // Try to mint them as ourselves before asking anyone for anything. This is the ONE
    // call site where a permission refusal is expected and already explained below, so
    // the child is told to stay quiet about it rather than print above our message.
    run(SHIP_JS, ['--ensure-schema'], { ...cfg, _quietDenied: true });
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
  // BEFORE the env file and BEFORE the ship. INSTALL.md's contract is that the config is
  // written last, "after everything above has proved out", because a config left by a
  // failed install is read as truth by the next command. Placed after the write, a
  // wrong-key house got four green ticks and a persisted config, and `status` then added
  // five more on a house that can never be shipped to.
  const keyProblem = await sortingKeyProblem(cfg);
  if (keyProblem) {
    console.log(bad(`the rooms are here, but their sorting keys are wrong: ${keyProblem}`));
    console.log('  a ship pass would corrupt them, so `memhouse ship` will refuse.');
    // migrate-rooms, not "rebuild by hand from the template" — this advice predated the
    // command and survived it, so an UPGRADING pilot (the main person who ever sees this)
    // was pointed at a manual rebuild that the tool now does for them, atomically and
    // without deleting anything.
    // With the SAME connection flags — no config was written (see below), so a bare
    // `memhouse migrate-rooms` here would answer "no house configured" and strand the
    // pilot in a loop between two refusals.
    console.log('  rebuild them (a copy + swap; nothing is deleted), then install again:');
    console.log(`     memhouse migrate-rooms --url ${cfg.url} --db ${cfg.db} --user ${cfg.user} --password …`);
    console.log('  no config was written — nothing here reads as installed.');
    return 1;
  }
  // Written LAST, and only once everything above proved out. Writing it first leaves a
  // config file behind every failed attempt, and the next command reads it as truth.
  writeEnvFile(cfg);
  console.log(ok(`config written: ${ENV_FILE}`));
  // A running shipper holds the OLD house until it restarts. It does not fail — it keeps
  // shipping, to the house that is no longer configured, while `status` shows a green
  // "shipper: running" beside a green "house: empty" and the new house stays at zero.
  // Measured in a drill: 145 sessions "skipped" into a house holding no rows, because the
  // skip predicate was still being evaluated against the old one. `relocate` restarts
  // deliberately for exactly this reason; install used to do nothing at all.
  if (displaces && shipperHealth().running) {
    const st = (() => { try { return require(path.join(REPO_ROOT, 'memhouse', 'service.js')).status(); } catch { return null; } })();
    const viaService = String(shipperHealth().via || '').startsWith('service');
    if (viaService && st) {
      const cmd = st.kind === 'systemd'
        ? ['systemctl', ['--user', 'restart', 'memhouse-shipper']]
        : ['launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.memhouse.shipper`]];
      const r = spawnSync(cmd[0], cmd[1], { stdio: 'pipe', encoding: 'utf-8' });
      console.log(r.status === 0 ? ok('shipper restarted against the new house')
        : warn('restart the shipper yourself, or it keeps writing to the old house:  memhouse service restart'));
    } else {
      const pid = pidOf('shipper');
      if (pid) { try { process.kill(pid, 'SIGTERM'); console.log(ok(`stopped the shipper (pid ${pid}) — it was pointed at the old house`)); } catch { /* raced */ } }
      console.log('  start it against the new one:  memhouse start');
    }
  }
  // Mint this machine's identity here rather than leaving it to whatever runs first.
  // Installing is the moment a machine joins the member's rooms, and the id is what every
  // later `WHERE host = …` depends on — so it is worth naming once, out loud, at the point
  // the pilot can still see it.
  {
    const me = require(path.join(REPO_ROOT, 'memhouse', 'host.js')).identity(HOME_DIR);
    console.log(ok(`host identity: ${me.id}`));
    console.log(`  every machine you install as '${cfg.user}' writes into the same rooms; this is what tells them apart`);
  }
  console.log(ok('installed'));
  printGettingStarted(cfg);
  await finishInvite(cfg);
  // Background first ship — same reasoning as the invite branch above.
  if (flags['no-ship'] !== true) startShipperBackground(resolveConfig());
  return 0;
}

// After a successful install FROM AN INVITE: offer to rotate the shared password to one
// only this machine knows (the member holds ALTER USER on themselves, so no admin), then
// delete the spent file. Interactive offers (default yes); --yes rotates unasked; a
// non-TTY without --yes only advises. All best-effort — a failed rotation never fails the
// install, it just leaves the inviter's password in place with a warning.
async function finishInvite(cfg) {
  if (_inviteWantsRotate) {
    let go = flags.yes === true;
    if (!go && process.stdin.isTTY) {
      const a = (await ask('This password was set by whoever invited you. Change it to one only you know now? (Y/n)', 'Y')).toLowerCase();
      go = a === '' || a === 'y' || a === 'yes';
    }
    if (go) {
      const code = await cmdPasswd({ quiet: true });
      if (code !== 0) {
        // Rotation failed and its own state may be uncertain — KEEP the invite file (it
        // still carries the password the config was just written from) so nothing is
        // stranded, and do not claim it is spent.
        console.log(warn(`rotation did not complete — keeping ${_inviteFileToShred} for now; retry: memhouse passwd`));
        return;
      }
    } else {
      console.log(warn('keeping the invited password — rotate when ready:  memhouse passwd'));
    }
  }
  if (_inviteFileToShred) {
    try {
      fs.unlinkSync(_inviteFileToShred);
      console.log(ok(`removed the spent invite file ${_inviteFileToShred}`));
    } catch { /* already gone, or read-only — the file's own header told them to delete it */ }
  }
}

/**
 * What now — printed once, at the end of a successful install. An install that ends with
 * one next-step line leaves the pilot at a working house they do not know how to use:
 * the dashboard, the agent skills, and the health check all exist, and nothing said so.
 * Kept to one screen; each line is a thing to DO, not a feature list.
 */
function printGettingStarted(cfg) {
  console.log('');
  console.log('  Your house is live. From here:');
  console.log('     memhouse start                  dashboard + shipper loop (background daemons)');
  console.log(`       -> http://localhost:${cfg.port || 4640}       browse, search, and analyze every session`);
  console.log('     memhouse service install        or: ship at login, no terminal needed');
  console.log('     memhouse plugins install claude give your agents /mem:house, /mem:recall,');
  console.log('                                     /mem:recall, /mem:access, /mem:sql,');
  console.log('                                     /mem:house');
  console.log('     memhouse search <terms>         find a past conversation right now');
  console.log('     memhouse doctor                 every line a check mark = healthy');
  console.log('  The house keeps shipping as you work; nothing else to do.');
}

async function cmdOnboard() {
  ONBOARDING = true;
  let deployed = false;
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
        if (rc.status !== 0) return rc.status || 1;
        // Fall through to the daemon prompt below rather than returning. This branch —
        // "no ClickHouse yet", the README's headline scenario — used to return here, so
        // `onboard` skipped its own last step: HELP says onboard is
        // discover → configure → ship → START, the README says it "ships, and starts the
        // dashboard", and doctor then exited 1 on a fresh, entirely successful install
        // because neither daemon was running. Measured on a clean machine.
        deployed = true;
      }
    } else {
      console.log(warn('No reachable ClickHouse found, and neither docker nor podman is on PATH.'));
      console.log('  Point at one you already run, or install a container engine and use: memhouse deploy --local');
    }
    console.log('');
  }
  // `deploy --local` already installed and shipped, so asking the install questions again
  // would prompt for a house it just built.
  if (!deployed) {
    const code = await cmdInstall({ interactive: true });
    if (code !== 0) return code;
  }
  const yn = (await ask('Start the daemons now? (Y/n)', 'Y')).toLowerCase();
  if (yn !== 'n' && yn !== 'no') await cmdStart();

  // The skills were the one delivered thing onboarding never mentioned. They shipped,
  // they were packaged as a plugin, and the only way to find them was to already know
  // `memhouse plugins install claude` — so a pilot completed the whole wizard and ended up
  // with a house their agent could not query. Offer them here, across every Claude instance
  // found, all selected.
  const targets = claudeTargets();
  if (targets.length) {
    console.log('');
    console.log(`Claude Code skills: ${skillNames().map((n) => `/mem:${n}`).join(', ')}`);
    const chosen = await chooseTargets(targets, 'Install into');
    for (const t of chosen) console.log(ok(`installed skills into ${short(installPluginInto(t.dir))}`));
    if (chosen.length) console.log('  they load next time that Claude Code starts');
    else console.log(warn('skipped — install later with: memhouse plugins install claude'));
  }
  return 0;
}

async function cmdStart() {
  const cfg = requireConfig(resolveConfig(), 'start');
  fs.mkdirSync(RUN_DIR, { recursive: true });
  // Record the port this run actually used. `start --port 4673` did not persist it, so
  // `status` fell back to the env file and printed `dashboard → http://localhost:4640` —
  // a live process on 4673 named alongside a link to someone else's dashboard on 4640.
  try { fs.writeFileSync(path.join(RUN_DIR, 'dashboard.port'), String(cfg.port)); } catch { /* best effort */ }
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
  try { svcStatus = require(path.join(REPO_ROOT, 'memhouse', 'service.js')).status(); } catch { /* unsupported platform */ }
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
  const started = [];
  for (const d of daemons) {
    if (pidOf(d.name)) { console.log(warn(`${d.name} already running (pid ${pidOf(d.name)})`)); continue; }
    const log = fs.openSync(path.join(LOG_DIR, d.name + '.log'), 'a');
    const child = spawn(process.execPath, [d.script, ...d.args], {
      env: childEnv(cfg), detached: true, stdio: ['ignore', log, log],
    });
    fs.writeFileSync(path.join(RUN_DIR, d.name + '.pid'), String(child.pid));
    child.unref();
    started.push({ ...d, pid: child.pid });
  }

  // spawn() succeeding means the PROCESS started, not that it is still alive or that it
  // got the port. `start` used to print "✓ dashboard started (pid …)" and a URL for a
  // process that had already died of EADDRINUSE — and the URL then pointed at whatever
  // else owned the port, which on this machine was a different house's dashboard. Give
  // each a moment, then confirm, and dig the reason out of the log rather than making the
  // user find it.
  if (started.length) await new Promise((r) => setTimeout(r, 900));
  let dashboardAlive = false;
  for (const d of started) {
    if (alive(d.pid)) {
      console.log(ok(`${d.name} started (pid ${d.pid})`));
      if (d.name === 'dashboard') dashboardAlive = true;
      continue;
    }
    try { fs.unlinkSync(path.join(RUN_DIR, d.name + '.pid')); } catch { /* already gone */ }
    const logPath = path.join(LOG_DIR, d.name + '.log');
    let why = '';
    try {
      const tail = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).slice(-40);
      const err = tail.reverse().find((l) => /EADDRINUSE|Error|error:/i.test(l));
      if (/EADDRINUSE/.test(err || '')) why = `port ${cfg.port} is already in use — free it, or set MEMHOUSE_PORT`;
      else if (err) why = err.trim().slice(0, 200);
    } catch { /* no log to read */ }
    console.log(bad(`${d.name} exited immediately${why ? ` — ${why}` : ''}`));
    if (!why) console.log(`  see ${logPath}`);
    process.exitCode = 1;
    // Partial success is the confusing case: exit 1 reads as "nothing started", and the
    // daemon that DID start keeps running unmentioned.
    const others = started.filter((o) => o.name !== d.name && alive(o.pid));
    if (others.length) {
      console.log(`  ${others.map((o) => o.name).join(' and ')} ${others.length > 1 ? 'are' : 'is'} still running — memhouse stop, if you did not want that`);
    }
  }
  if (dashboardAlive || (pidOf('dashboard') && !started.some((d) => d.name === 'dashboard'))) {
    console.log(`  dashboard → http://localhost:${cfg.port}`);
  }
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

/**
 * Every writer this house has, judged. Ground truth is the DATA — distinct
 * (user_id, host) over the messages room — because the one writer that matters most, a
 * pre-0.10 memhouse, records nothing about itself: it predates the house record
 * entirely. The record then annotates whoever it knows.
 *
 *   'legacy'    rows in the house, no record of a writer — a pre-0.10 memhouse. It still
 *               deletes before re-inserting, and on migrated rooms that delete reaches
 *               every retained parse it re-ships. The state worth shouting about.
 *   'outdated'  recorded, but supports an older schema than the house is at — it is
 *               refusing every pass right now and ships nothing until updated.
 *   'stale'     no heartbeat for 48h — machine off, or shipper dead.
 *   'ok'        current and beating.
 *
 * Null when the house is unreachable or holds no rows at all.
 */
async function fleetState(cfg) {
  try {
    const writers = new Map(); // 'member@host' -> row
    for (const d of await chRows(cfg,
      `SELECT user_id, host, formatDateTime(max(ingested_at), '%Y-%m-%dT%H:%i:%SZ') AS last_row FROM ${physicalRoom('messages', cfg.user)} GROUP BY user_id, host`)) {
      writers.set(`${d.user_id}@${d.host}`, { writer: `${d.user_id}@${d.host}`, lastRow: d.last_row, version: null, schema: null, lastShip: null });
    }
    if (!writers.size) return null;
    let houseSchema = 0;
    try {
      for (const r of await chRows(cfg,
        `SELECT key, value FROM ${physicalRoom('house_meta', cfg.user)} FINAL WHERE key = 'schema_version' OR key LIKE 'client_%' OR key LIKE 'last_ship:%'`)) {
        if (r.key === 'schema_version') { houseSchema = Number(r.value) || 0; continue; }
        const cut = r.key.indexOf(':');
        const kind = r.key.slice(0, cut); const who = r.key.slice(cut + 1);
        const w = writers.get(who) || { writer: who, lastRow: null, version: null, schema: null, lastShip: null };
        if (kind === 'client_version') w.version = String(r.value);
        if (kind === 'client_schema') w.schema = Number(r.value) || null;
        if (kind === 'last_ship') w.lastShip = String(r.value);
        writers.set(who, w);
      }
    } catch { /* pre-0.10 house: no record — every writer below reads as legacy, correctly */ }
    const out = [];
    for (const w of writers.values()) {
      const beat = w.lastShip || (w.lastRow ? `${w.lastRow.replace(' ', 'T')}` : null);
      const ageMs = beat ? Date.now() - Date.parse(beat) : null;
      // ROWS newer than the heartbeat by more than a pass interval = something on that
      // host is writing without recording itself — a machine DOWNGRADED to pre-0.10
      // after it had recorded. Judged on the record alone it read 'ok' for two days,
      // while actively running the delete-before-reinsert the verdict exists to flag.
      const rowMs = w.lastRow ? Date.parse(`${w.lastRow.replace(' ', 'T')}`) : null;
      const shipMs = w.lastShip ? Date.parse(w.lastShip) : null;
      const writingUnrecorded = rowMs !== null && shipMs !== null && rowMs - shipMs > 3600 * 1000;
      w.verdict = ((w.schema === null && w.version === null) || writingUnrecorded) ? 'legacy'
        : (w.schema !== null && houseSchema && w.schema < houseSchema) ? 'outdated'
          : (ageMs !== null && ageMs > 48 * 3600 * 1000) ? 'stale' : 'ok';
      w.ageMs = ageMs;
      out.push(w);
    }
    return out.sort((a, b) => a.writer.localeCompare(b.writer));
  } catch { return null; }
}

function fleetAge(ms) {
  if (ms === null) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function cmdStatus() {
  // requireConfig, not resolveConfig. `status` reads a house and reports its counts as
  // YOURS, which is exactly the answer that must not come from a guessed URL: with no
  // config it connected to localhost:8123 as memhouse_root and, wherever that credential
  // works, printed a stranger's session and message counts as the pilot's own.
  const cfg = requireConfig(resolveConfig(), 'status');
  const out = {
    config: fs.existsSync(ENV_FILE) ? ENV_FILE : null,
    url: cfg.url, db: cfg.db, user: cfg.user,
    daemons: { shipper: pidOf('shipper'), dashboard: pidOf('dashboard') },
    dashboard_url: pidOf('dashboard') ? `http://localhost:${runningPort(cfg)}` : null,
    shipper: shipperHealth(),
    // Which machine this is, in the rooms' own terms. All of a member's machines write
    // into one set of rooms, so `WHERE host = ...` is how the pilot separates this laptop
    // from the other one — and they cannot type it if nothing ever prints it.
    host: require(path.join(REPO_ROOT, 'memhouse', 'host.js')).identity(HOME_DIR),
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
    out.fleet = await fleetState(cfg);
  } catch (e) { out.connected = false; out.error = netReason(e); }

  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return out.connected ? 0 : 1; }
  console.log(out.config ? ok(`config: ${out.config}`) : warn('no config (memhouse install)'));
  console.log(out.connected
    ? ok(`connected: ${cfg.url} / ${cfg.db} as ${cfg.user}`)
    : bad(`not connected: ${cfg.url} — ${out.error || 'no reason given'}`));
  if (!out.connected) console.log('  diagnose it with: memhouse doctor');
  if (out.member) console.log(ok(`rooms for '${out.member}'`));
  // The member owns the rooms; the host says which of their machines wrote a row.
  console.log(ok(`host: ${out.host.id}${out.host.renamed ? ` (this machine now answers to '${out.host.current_hostname}' — the id is kept so its history stays one machine)` : ''}`));
  if (out.connected && !out.messages) console.log(ok(`house: empty — ${out.sessions} sessions, 0 messages (nothing shipped yet)`));
  else if (out.connected) console.log(ok(`house: ${out.sessions} sessions, ${out.messages} messages (freshest ingest ${out.freshest} UTC)`));
  if (out.fleet && out.fleet.length) {
    const badOnes = out.fleet.filter((f) => f.verdict !== 'ok');
    console.log((badOnes.length ? warn : ok)(`fleet: ${out.fleet.length} writer(s) known to this house`));
    for (const f of out.fleet) {
      const mark = f.verdict === 'legacy' ? '  ⚠ pre-0.10 — upgrade it (or revoke its mutation grants); its re-ships delete retained parses'
        : f.verdict === 'outdated' ? '  ⚠ supports an older schema — refusing every pass until updated'
          : f.verdict === 'stale' ? '  • stale' : '';
      console.log(`     ${f.writer.padEnd(28)} ${String(f.version || '?').padEnd(8)} last ship ${fleetAge(f.ageMs)}${mark}`);
    }
  }
  console.log(out.shipper.running ? ok(`shipper: running — ${out.shipper.via}`) : warn('shipper: not running'));
  console.log(out.daemons.dashboard ? ok(`dashboard: running (pid ${out.daemons.dashboard})`) : warn('dashboard: not running'));
  if (out.daemons.dashboard) console.log(`  dashboard → http://localhost:${runningPort(cfg)}`);
  // Exit non-zero when the house is unreachable. `status` is what a health check, a
  // cron, or an agent gates on; printing '✗ not connected' and exiting 0 tells every
  // one of them the house is fine.
  return out.connected ? 0 : 1;
}

async function cmdDoctor() {
  const cfg = resolveConfig();
  const checks = [];
  const add = (okFlag, label, hint) => checks.push({ ok: okFlag, label, hint });

  // 24 because SQLite comes from `node:sqlite`, which is stable there. It works on 22.13+
  // but prints an ExperimentalWarning on every command, and 20 is past EOL. Below the
  // floor, the five SQLite-backed adapters are the part that actually breaks.
  const [major] = process.versions.node.split('.').map(Number);
  add(major >= 24, `node ${process.versions.node}`, 'need >= 24 — node:sqlite is stable there; the SQLite-backed adapters need it');
  add(fs.existsSync(ENV_FILE), `config ${ENV_FILE}`, 'run: memhouse install');
  // doctor is exempt from requireConfig — diagnosing an unconfigured machine is its job —
  // but "exempt from refusing" is not "licensed to log in somewhere". With no config it
  // used to print `✗ config … run: memhouse install` and then attempt an AUTHENTICATED
  // connection to http://localhost:8123 as memhouse_root, the address every other command
  // explicitly declines to guess. The server answers AUTHENTICATION_FAILED, which on a
  // hardened house is a failed-login entry per run — and doctor is the first thing a
  // confused user types. `discover` still probes 8123, and should: it reports what is
  // reachable as a DISCOVERY. A check that reports someone else's server as a failure of
  // your config is a different thing.
  if (!cfg.stated) {
    add(false, 'house', 'no config, so there is nothing to connect to — run: memhouse install');
    for (const label of ['rooms', 'schema', 'sorting keys', 'identity stamping']) {
      add(false, label, 'skipped — no house configured');
    }
    return renderDoctor(checks);
  }
  try { await ch(cfg, 'SELECT 1', { database: '' }); add(true, `clickhouse reachable (${cfg.url})`); }
  catch (e) { add(false, `clickhouse reachable (${cfg.url})`, netReason(e)); }
  let rooms = null;
  // Room resolution asks the server who you are (SELECT currentUser()). It fails when
  // the house is unreachable or the credential is rejected — both already reported by
  // the check above, so name that as the fix rather than repeating the driver's error.
  try { rooms = await roomsFor(cfg); } catch (e) {
    add(false, 'room resolution', `${e.message} — fix the connection above first (memhouse install --url … --user … --password …)`);
  }
  // "rooms for X" means the NAMES resolved, not that the rooms exist — and it printed a
  // green tick immediately above `✗ schema: 0/3 rooms`, contradicting the next line.
  if (rooms) add(true, `member is '${rooms.member}' — rooms would be ${ROOM_TYPES.map((ty) => rooms[`${ty}_raw`]).join(', ')}`);
  // Every check below reads a room NAME, so none of them can run without `rooms`.
  // Reaching into a null here is how doctor used to print a raw
  // "Cannot read properties of null (reading 'sessions')" as its hint — a stack-trace
  // fragment where the fix should be. Skip them, and say why they were skipped.
  if (!rooms) {
    add(false, 'schema', 'skipped — room names are unknown until the house answers');
    add(false, 'identity stamping', 'skipped — same reason');
  } else {
    try {
      // Three rooms. The session rollup every read path goes through is a saved query over
      // exactly these, so if they are here it is too — there is no fourth object to lose.
      const objects = ROOM_TYPES.map((t) => rooms[`${t}_raw`]);
      const want = objects.map((n) => `'${n}'`).join(',');
      const t = (await chRows(cfg, `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN (${want})`, { database: '' })).length;
      // Name what is MISSING. The parenthesised list used to be what should exist, so
      // "2/3" was the only signal and you could not tell which room to worry about.
      const present = new Set((await chRows(cfg, `SELECT name FROM system.tables WHERE database = '${cfg.db}' AND name IN (${want})`, { database: '' })).map((r) => r.name));
      const absent = objects.filter((n) => !present.has(n));
      add(t === objects.length, t === objects.length
        ? `schema: 3/3 rooms in '${cfg.db}' (${objects.join(', ')})`
        : `schema: ${t}/${objects.length} rooms in '${cfg.db}' — missing ${absent.join(', ')}`,
        `run: memhouse install — with ALL on the house, ship --ensure-schema builds them`);
    } catch (e) { add(false, 'schema check', `${e.message} — run: memhouse install`); }
    // Columns, not just rooms. A room with a column missing accepts every insert and
    // discards that field — measured, 85 rows shipped with the value thrown away while
    // ship, install, --ensure-schema and doctor all reported success, because this check
    // counted rooms.
    try {
      const { templateColumns } = require(path.join(REPO_ROOT, 'memhouse', 'shipper', 'ship.js'));
      const tpl = fs.readFileSync(path.join(REPO_ROOT, 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
      const want = templateColumns(tpl);
      // Names AND types AND the MATERIALIZED kind. Comparing names alone left every other
      // kind of drift invisible, with measured consequences: a `UInt64` column narrowed to
      // `Int8` stored 200 as **-56**, silently, so token counts and every cost derived
      // from them were wrong; and `text_ngram` without its MATERIALIZED clause was empty
      // on all 33 rows, so the FTS column the search skill queries had simply stopped
      // being populated. Both read `✓ columns: every room matches the schema template`.
      const missing = [];
      const wrong = [];
      let roomsSeen = 0;
      for (const ty of ROOM_TYPES) {
        const cols = await chRows(cfg, `SELECT name, type, default_kind FROM system.columns WHERE database = '${cfg.db}' AND table = '${rooms[`${ty}_raw`]}'`, { database: '' });
        if (!cols.length) continue;
        roomsSeen++;
        const byName = new Map(cols.map((r) => [r.name, r]));
        for (const c of (want[ty] || [])) {
          const got = byName.get(c.name);
          if (!got) { missing.push(`${rooms[`${ty}_raw`]}.${c.name}`); continue; }
          // The template's declaration is `<type> [DEFAULT x | MATERIALIZED x]`; compare
          // the type word and, when the template says MATERIALIZED, that the column still is.
          const wantType = c.type.replace(/\s+(DEFAULT|MATERIALIZED|ALIAS|EPHEMERAL)\b[\s\S]*$/i, '').trim();
          const wantKind = /\bMATERIALIZED\b/i.test(c.type) ? 'MATERIALIZED' : null;
          if (wantType && got.type !== wantType) wrong.push(`${rooms[`${ty}_raw`]}.${c.name} is ${got.type}, template says ${wantType}`);
          else if (wantKind && got.default_kind !== 'MATERIALIZED') wrong.push(`${rooms[`${ty}_raw`]}.${c.name} lost its MATERIALIZED clause`);
        }
      }
      const bad2 = missing.length + wrong.length;
      add(bad2 === 0 && roomsSeen === ROOM_TYPES.length,
        roomsSeen !== ROOM_TYPES.length ? `columns: only ${roomsSeen}/${ROOM_TYPES.length} rooms exist, so the template comparison is incomplete`
          : bad2 === 0 ? 'columns: every room matches the schema template (name, type and kind)'
            : `columns: ${missing.length} missing, ${wrong.length} wrong — ${[...missing, ...wrong].slice(0, 4).join('; ')}${bad2 > 4 ? ' …' : ''}`,
        missing.length && !wrong.length
          ? 'those fields are being discarded on every ship; heal with: memhouse ship --ensure-schema'
          : 'a changed type silently corrupts values and a lost MATERIALIZED clause stops a column being computed; the room has to be rebuilt by its owner');
    } catch (e) { add(false, 'columns', `could not compare against the template: ${e.message}`); }

    // The sorting keys the shipper refuses to write into. doctor is where a house should
    // learn it needs rebuilding, not the middle of a ship pass.
    let keysCorrect = false;
    try {
      const wrongKeys = [];
      let checked = 0;
      for (const t of ROOM_TYPES) {
        const r = await chRows(cfg, `SELECT sorting_key AS k FROM system.tables WHERE database = '${cfg.db}' AND name = '${rooms[`${t}_raw`]}'`, { database: '' });
        const key = r[0]?.k;
        if (!key) continue;
        checked++;
        // One checker, in house.js beside the keys themselves — doctor and the shipper
        // disagreeing about what a correct room looks like is how a house gets shipped
        // into after doctor called it healthy.
        const problem = keyProblem(t, key);
        if (problem) wrongKeys.push(`${rooms[`${t}_raw`]} ${problem}`);
      }
      // `checked` matters: every room name that resolved to nothing was skipped by the
      // `continue` above, so on an empty house this printed a green "sorting keys carry
      // origin correctly" having examined zero tables — a reassuring tick on the exact
      // check that a broken house needs to fail.
      // A room whose sorting_key is empty was SKIPPED by the loop — that is a Merge, a
      // View, a Log engine, anything that is not the MergeTree this expects. Skipping is
      // right; calling the result a pass is not. It printed
      // "✓ sorting keys carry origin correctly (2/3 rooms)" on a house where `ship` then
      // failed with "DELETE query is not supported for table …". The number was right
      // there in the green line.
      if (!checked) add(false, 'sorting keys: no rooms to check', 'create them first: memhouse install');
      else if (checked < ROOM_TYPES.length) {
        add(false, `sorting keys: only ${checked}/${ROOM_TYPES.length} rooms are MergeTree — the rest have no sorting key at all`,
          'a room was replaced by a Merge/View/Log engine; rebuild it from the schema template as the house owner');
      } else {
        keysCorrect = wrongKeys.length === 0;
        add(keysCorrect, `sorting keys${keysCorrect ? ` carry origin and epoch correctly (${checked}/${ROOM_TYPES.length} rooms)` : `: wrong on ${wrongKeys.join(', ')}`}`,
          'those rooms predate the epoch key, so the shipper refuses to write into them.\n     rebuild them (nothing is deleted): memhouse migrate');
      }
    } catch (e) { add(false, 'sorting keys', e.message); }
    // What the house says about ITSELF — its schema generation and whether a rebuild was
    // left half-done. A migration that failed between the copy and the swap leaves rooms
    // that still work and a `<room>__migrating` nobody would notice; the events table is
    // the only place that shows it, so doctor reads it rather than the pilot.
    try {
      const meta = new Map((await chRows(cfg, `SELECT key, value FROM ${physicalRoom('house_meta', cfg.user)} FINAL`))
        .map((m) => [m.key, String(m.value)]));
      const at = meta.get('schema_version');
      const last = (await chRows(cfg,
        `SELECT id, argMax(status, event_at) AS status, formatDateTime(max(event_at), '%Y-%m-%d %H:%i') AS at
         FROM ${physicalRoom('house_events', cfg.user)} WHERE kind = 'migration' GROUP BY id ORDER BY max(event_at) DESC LIMIT 1`))[0];
      const stuck = last && last.status !== 'applied';
      // The ROOMS are the truth; this table is the paperwork. A house whose keys are
      // already current but whose record is missing — a fresh install by an older client,
      // or a member with no rights on house_meta — is not un-migrated, and telling it to
      // run migrate-rooms sends the pilot to rebuild rooms that are already correct.
      const recorded = at === String(SCHEMA_VERSION);
      add(!stuck && (recorded || keysCorrect),
        stuck ? `house record: migration ${last.id} is ${last.status} (last touched ${last.at})`
          : recorded ? `house record: schema ${at}, no migration pending`
            : keysCorrect ? `house record: rooms are at schema ${SCHEMA_VERSION}, unrecorded`
              : `house record: schema ${at || 'unrecorded'}, this memhouse expects ${SCHEMA_VERSION}`,
        stuck ? 're-run it — it is restartable and removes nothing: memhouse migrate-rooms'
          : keysCorrect ? 'record it: memhouse ship --ensure-schema'
            : 'bring the rooms up to this version: memhouse migrate-rooms');
    } catch {
      // A house from before these tables existed, or a member without rights on them.
      // Neither is a fault: the rooms are the product, and the sorting-key check above
      // already answers the question that matters.
      add(true, 'house record: not kept in this house (pre-0.10 house, or no rights)');
    }
    // The fleet: every writer the house has seen, and whether any of them is a danger.
    // A pre-0.10 memhouse on ANOTHER machine reads none of this house's record and still
    // deletes before re-inserting — on migrated rooms that delete reaches every retained
    // parse of a session it re-ships. It cannot be stopped by code here; it can only be
    // named, loudly, where the pilot looks.
    try {
      const fleet = await fleetState(cfg);
      if (fleet && fleet.length) {
        const old = fleet.filter((f) => f.verdict === 'legacy' || f.verdict === 'outdated');
        const stale = fleet.filter((f) => f.verdict === 'stale');
        add(old.length === 0,
          old.length
            ? `fleet: ${old.length} of ${fleet.length} writer(s) need attention — ${old.map((f) => `${f.writer} (${f.verdict})`).join(', ')}`
            : `fleet: ${fleet.length} writer(s), all current${stale.length ? ` (${stale.length} stale >48h)` : ''}`,
          'their re-ships DELETE retained parses on this house. Upgrade them, or as admin:\n'
          + `     REVOKE ALTER DELETE, ALTER UPDATE ON ${cfg.db}.* FROM <member>`);
      }
    } catch { /* fleet view is best-effort */ }
    try {
      // countIf, not any(). `any()` returns an arbitrary row's value, so on a house with
      // four correctly-stamped rows and one blank it reported a pass five times out of
      // six — the one check whose whole purpose is to catch unattributed rows. Count them
      // instead, and say how many: a row with an empty user_id is invisible to every
      // identity-bound path at once (loadExisting's WHERE, the shipper's clear, reset's
      // DELETE), so its owner cannot even remove it.
      // All three rooms. This read only `sessions`, and the two it skipped are where the
      // shipper writes almost everything — measured, a messages row with an empty user_id
      // sat there while this printed "all attributed". An unattributed row is invisible to
      // every identity-bound path at once, including its owner's own reset.
      let total = 0; let blank = 0;
      for (const ty of ROOM_TYPES) {
        const r = (await chRows(cfg, `SELECT count() AS c, countIf(user_id = '') AS blank FROM ${rooms[`${ty}_raw`]} FINAL`))[0] || {};
        total += Number(r.c || 0); blank += Number(r.blank || 0);
      }
      add(blank === 0,
        total === 0 ? 'identity stamping (no rows yet)'
          : blank === 0 ? `identity stamping (${total} rows across all three rooms, all attributed)`
            : `identity stamping: ${blank} of ${total} rows have an empty user_id`,
        'a writer used async_insert=1 — the MATERIALIZED currentUser() stamp does not run during an async flush');
    } catch { add(false, 'identity stamping', 'schema missing? run: memhouse install'); }

    // Which machines this member's rooms already hold, and whether THIS one is among
    // them. All of a member's machines write into one set of rooms, so a host id that
    // has quietly changed shows up here as a second machine that never existed — and
    // nothing else in the pipeline would ever mention it.
    try {
      const me = require(path.join(REPO_ROOT, 'memhouse', 'host.js')).identity(HOME_DIR);
      const hosts = await chRows(cfg, `SELECT host, count() AS c FROM ${rooms.sessions} FINAL GROUP BY host ORDER BY c DESC`);
      const mine = hosts.find((h) => h.host === me.id);
      const others = hosts.filter((h) => h.host !== me.id);
      add(true,
        hosts.length === 0
          ? `host identity ${me.id} (nothing shipped from here yet)`
          : `host identity ${me.id} — ${mine ? `${mine.c} sessions from this machine` : 'no sessions from this machine yet'}`
            + (others.length ? `, ${others.length} other host${others.length > 1 ? 's' : ''} in these rooms: ${others.map((h) => `${h.host} (${h.c})`).join(', ')}` : ''));
      if (me.renamed) {
        add(true, `host renamed since install — id stays ${me.id}, machine now answers to '${me.current_hostname}'`);
      }
    } catch { /* the room read above already reported anything that would break this */ }
  }
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
      if (!adapterErrors.some((e) => e.source === t.source)) adapterErrors.push(t);
    }
    // Any adapter that could not be read is a failure, whatever the cause — a locked or
    // corrupt store loses sessions just as surely as the missing native binding this
    // used to have a separate remedy for.
    const failed = adapterErrors.map((e) => e.source);
    add(adapterErrors.length === 0,
      // "visible locally" is what the ADAPTERS see; `stats` reports what the house HOLDS,
      // and the two differ legitimately — a session that parses to zero messages is
      // visible and not worth a row. Saying "visible locally" and leaving the reader to
      // find the other number elsewhere (161 here, 156 there, on a real machine) gives
      // them no way to tell "correctly skipped" from "silently dropped".
      `adapters: ${seen} sessions visible locally${failed.length ? ` (${failed.length} skipped: ${failed.join(', ')})` : ''} — compare with what the house holds: memhouse stats`,
      adapterErrors.length ? adapterErrors.map((e) => `${e.source}: ${e.message}`).join('; ') : undefined);
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

    // A source whose rows carry NO tokens costs nothing in the dashboard, which reads as
    // "this editor is free" rather than "this editor's usage was never parsed". That is
    // the same shape as the unpriced-model gap above, which once hid $6,919 — except no
    // price list can fix it, because the numbers were never extracted. zed is the current
    // case: editors/zed.js contains no usage handling at all.
    // origin='ship' only. Imported history came from another product that may never have
    // recorded usage — on this machine four of the five zero-token sources are imports
    // from memory-house, which is a fact about the past, not an adapter that needs fixing.
    // Naming them alongside a live adapter gap makes the real one easy to dismiss.
    const zero = await chRows(cfg,
      `SELECT source, count() AS n FROM ${rooms.messages_raw} FINAL WHERE role = 'assistant' AND origin = 'ship' GROUP BY source HAVING sum(input_tokens) + sum(output_tokens) = 0 ORDER BY source`);
    const zeroImported = await chRows(cfg,
      `SELECT count() AS n FROM ${rooms.messages_raw} FINAL WHERE role = 'assistant' AND origin != 'ship' AND input_tokens = 0 AND output_tokens = 0`);
    const impN = Number(zeroImported[0]?.n || 0);
    add(zero.length === 0,
      zero.length === 0
        ? `token capture: every editor shipping into this house reports usage${impN ? ` (${impN} imported messages carry none — historical, not fixable here)` : ''}`
        : `token capture: ${zero.map((r) => `${r.source} (${r.n} messages)`).join(', ')} ship ZERO tokens — their cost shows as $0, not as unknown`,
      'that adapter does not extract usage; the messages are stored, the numbers are not');
  } catch { /* a house that cannot be read is already reported above */ }
  const sh = shipperHealth();
  add(sh.running, `shipper${sh.via ? ` — ${sh.via}` : ''}`, 'memhouse start (or: memhouse service install)');
  add(!!pidOf('dashboard'), 'dashboard daemon', 'memhouse start');
  add(fs.existsSync(path.join(REPO_ROOT, 'public', 'index.html')), 'dashboard UI built', 'built automatically by memhouse start');

  return renderDoctor(checks);
}

function renderDoctor(checks) {
  for (const c of checks) console.log(c.ok ? ok(c.label) : bad(`${c.label}${c.hint ? ` — ${c.hint}` : ''}`));
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function cmdSearch() {
  if (!positional.length) { console.log('usage: memhouse search <terms…>'); return 2; }
  const cfg = requireConfig(resolveConfig(), 'search');
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
    // The full id. It was sliced to 8 characters, which for claude-code renders every hit
    // as the literal string "claude-c" — while the shipped prompt tells agents to cite the
    // session_id and to replay with `WHERE session_id = '<id>'`. Neither is possible from
    // a prefix, and the prefix is not even distinguishing.
    console.log(`\x1b[1m${r.session_id}\x1b[0m  ${r.source}  ${r.project || '-'}  ${r.at}  (${r.hits} hit${r.hits === 1 ? '' : 's'})`);
    console.log(`  ${r.snippet.replace(/\s+/g, ' ')}`);
  }
}

// `search` finds the session; this hands the pilot back into it. memhouse has been a
// read-only archive — you could find the conversation that solved this before and not
// return to it.
//
// It PRINTS the command and does not run it, and that is the whole design. Running it would
// have to guess a terminal, inherit this process's cwd, and hope the id is still live; when
// any of that is wrong the CLI does not fail, it opens a NEW session — the pilot loses the
// transcript they asked for while the tool reports success. Printed, the pilot reads it,
// pastes it, and owns the result.
async function cmdResume() {
  if (!positional.length) {
    console.log('usage: memhouse resume <session-id>    (the id search and the dashboard print)');
    return 2;
  }
  const cfg = requireConfig(resolveConfig(), 'resume');
  const { resumeFor } = require(path.join(REPO_ROOT, 'memhouse', 'resume'));
  // Same escaping as search: this value is interpolated into SQL, and a session id is not
  // guaranteed to be tame — it comes from whatever the editor wrote on disk.
  const want = positional[0].replace(/[\\']/g, '\\$&');
  const r = await roomsFor(cfg);
  // Two ways to name a session, because there are two ways it gets in front of the pilot:
  // the canonical `<source>:<id>` that search and the prompt print, and the bare native id
  // that the editor's own UI shows. FINAL because sessions is a ReplacingMergeTree and a
  // re-shipped session has an older row underneath — without it a moved project resolves to
  // the folder it used to live in.
  const rows = await chRows(cfg, `
    SELECT session_id, source, folder, name, origin,
           formatDateTime(last_updated_at, '%Y-%m-%d %H:%i') AS at
    FROM ${r.sessions} FINAL
    WHERE session_id = '${want}' OR session_id LIKE '%:${want}'
    ORDER BY last_updated_at DESC LIMIT 5`);

  if (!rows.length) {
    if (JSON_OUT) return console.log(JSON.stringify({ error: 'no such session', session_id: positional[0] }, null, 2));
    console.log(bad(`no session '${positional[0]}' in ${r.sessions}`));
    console.log('  find one with: memhouse search <terms>');
    return 1;
  }
  // A bare native id can match more than one source. Say so instead of picking — resuming
  // the wrong editor's session of the same name is exactly the silent-wrong-answer this
  // command exists to avoid.
  if (rows.length > 1) {
    if (JSON_OUT) return console.log(JSON.stringify({ error: 'ambiguous', matches: rows }, null, 2));
    console.log(warn(`'${positional[0]}' matches ${rows.length} sessions — name one exactly:`));
    for (const s of rows) console.log(`  ${s.session_id}  ${s.at}  ${s.name || '-'}`);
    return 1;
  }

  const row = rows[0];
  const res = resumeFor(row);
  if (JSON_OUT) return console.log(JSON.stringify({ ...row, ...res }, null, 2));
  // `last_updated_at` is Nullable and some imported rows carry no timestamp, which
  // formatDateTime returns as JSON null — printed raw it reads as the literal word 'null'
  // sitting where a date belongs.
  console.log(`\x1b[1m${row.session_id}\x1b[0m  ${row.at || '-'}  ${row.name || '-'}`);
  if (!res.ok) {
    console.log(bad(res.reason));
    // The folder is still worth printing: for a GUI editor it is the one actionable thing
    // memhouse knows, and opening it is what the pilot would do next anyway.
    if (res.folder) console.log(`  the session ran in: ${res.folder}`);
    return 1;
  }
  console.log('');
  console.log(`  ${res.command}`);
  console.log('');
  if (!res.folder) console.log(warn('no folder was recorded for this session — run it from the right directory yourself'));
  return 0;
}

// Which kind of installation is this process running out of? Every upgrade path below
// depends on the answer, and getting it wrong is not a no-op: running `git pull` in a
// global install does nothing visible, and `npm i -g` from a checkout installs the
// PUBLISHED version over the branch the pilot was testing.
function installKind() {
  const root = fs.realpathSync(REPO_ROOT);
  // npx unpacks into a cache directory keyed by a hash. Nothing there is upgradable — the
  // next `npx memhouse` resolves the registry again — and re-execing daemons out of a cache
  // entry that npm may evict is how a daemon ends up running from a directory that no
  // longer exists.
  if (/[/\\]_npx[/\\]/.test(root)) return { kind: 'npx', root };
  if (fs.existsSync(path.join(root, '.git'))) return { kind: 'checkout', root };
  if (/[/\\]node_modules[/\\]memhouse$/.test(root)) {
    // Global vs a project dependency. `npm prefix -g` is the only thing that tells them
    // apart, and it is worth the spawn: `npm i -g` from inside someone's project
    // dependency upgrades a different copy than the one they just ran.
    try {
      const p = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf-8' });
      const prefix = (p.stdout || '').trim();
      if (prefix && root.startsWith(fs.realpathSync(prefix))) return { kind: 'global', root };
    } catch { /* fall through */ }
    return { kind: 'local-dep', root };
  }
  return { kind: 'unknown', root };
}

// `npm i -g memhouse@latest` upgrades the files and nothing else: the flag that keeps five
// adapters alive has to be repeated, the daemons keep executing the version they booted
// with, and a house provisioned by an older shipper can be missing a room this one needs.
// Each of those has cost a real machine real sessions. This command owns all three.
async function cmdUpdate() {
  const { kind, root } = installKind();
  const latest = await (async () => {
    try {
      const res = await fetch('https://registry.npmjs.org/memhouse/latest', { signal: AbortSignal.timeout(8000) });
      return res.ok ? (await res.json()).version : null;
    } catch { return null; }
  })();

  if (JSON_OUT && flags.check) return console.log(JSON.stringify({ kind, root, current: PKG.version, latest }, null, 2));
  console.log(`  installed  ${PKG.version}  (${kind}: ${root})`);
  console.log(`  latest     ${latest || 'unknown — the registry did not answer'}`);
  if (latest && latest === PKG.version && kind !== 'checkout') console.log(ok('already current'));
  if (flags.check) return 0;

  if (kind === 'npx') {
    console.log(warn('nothing to update — npx resolves the registry on every run'));
    console.log('  to keep a version around: npm install -g memhouse');
    return 1;
  }
  if (kind === 'local-dep') {
    console.log(warn('this is a project dependency, not a global install'));
    console.log(`  upgrade it where it lives: npm install memhouse@latest`);
    return 1;
  }

  // Whether the daemons were OURS matters after the upgrade, not before: a service-managed
  // shipper must be restarted through its supervisor, and pidfile daemons only come back if
  // something restarts them. Read it first — `stop` erases the evidence.
  let svc = { installed: false, running: false };
  try { svc = require(path.join(REPO_ROOT, 'memhouse', 'service.js')).status(); } catch { /* unsupported platform */ }
  const wasRunning = { shipper: !!pidOf('shipper'), dashboard: !!pidOf('dashboard') };

  if (flags['no-install'] === true) {
    // The files were already replaced by other means — a hand-typed `npm i -g`, a tarball,
    // a configuration manager. The npm/git half is exactly what such a pilot has already
    // done, and the half a bare install leaves undone (restart, migrations, schema heal)
    // is exactly what they came here for.
    console.log(warn('--no-install: files assumed current; restarting and checking the house only'));
  } else if (kind === 'checkout') {
    // The stale-UI case, and it is checkout-only: a published tarball ships public/ built by
    // prepack, but `git pull` updates ui/src and leaves the old bundle in public/ — so the
    // dashboard serves the previous release however many times it is restarted.
    const steps = [
      ['git', ['pull', '--ff-only']],
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npm', ['run', 'build']],
    ];
    for (const [bin, args] of steps) {
      const r = spawnSync(bin, args, { cwd: root, stdio: 'inherit' });
      if (r.status !== 0) {
        console.log(bad(`${bin} ${args.join(' ')} failed — stopping here, nothing was restarted`));
        return 1;
      }
    }
  } else {
    // Plain, with no flag to forget. This carried `--allow-scripts=better-sqlite3` for as
    // long as SQLite was a native module: npm never remembered it, and an upgrade without
    // it left the binding unbuilt and the five SQLite-backed adapters reading zero
    // sessions on every pass afterwards. There is no binding to build now.
    const r = spawnSync('npm', ['install', '-g', 'memhouse@latest'], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.log(bad('npm install failed — nothing was restarted, the running version is unchanged'));
      console.log('  if it was EACCES: ls -ld "$(npm prefix -g)" — root-owned needs sudo, yours needs a chown');
      return 1;
    }
  }
  console.log(ok('files updated'));

  // Refresh the Claude plugin wherever it is ALREADY installed, so `update` keeps the
  // skills in lockstep with the package instead of leaving a stale `/mem:*` behind. Only
  // dirs that already have it are touched — update never installs the plugin somewhere new.
  // The files copied are the ones npm/git just put on disk; the manifest is stamped with
  // the FRESH package version read off disk (this process still runs the pre-upgrade code,
  // so its in-memory PKG.version is a release behind).
  try {
    let fresh = PKG.version;
    try { fresh = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')).version || fresh; } catch { /* keep in-memory */ }
    const installed = claudeTargets().filter((t) => isPluginInstalled(t.dir));
    for (const t of installed) {
      const dst = installPluginInto(t.dir);
      try {
        const mf = path.join(dst, '.claude-plugin', 'plugin.json');
        const m = JSON.parse(fs.readFileSync(mf, 'utf-8'));
        if (m.version !== fresh) { m.version = fresh; fs.writeFileSync(mf, `${JSON.stringify(m, null, 2)}\n`); }
      } catch { /* leave the stamp installPluginInto wrote */ }
      console.log(ok(`plugin refreshed in ${short(t.dir)}`));
    }
    if (installed.length) console.log('  reload it in Claude Code:  /reload-plugins  (or restart the session)');
  } catch (e) {
    console.log(warn(`could not refresh Claude plugins: ${e.message.split('\n')[0]}`));
  }

  // Restarting is the half a bare `npm i -g` leaves undone. The daemons notice on their own
  // within a loop interval (memhouse/self-update.js), but a pilot who typed `update` should
  // not have to wait for it, and the dashboard's stale bundle is visible immediately.
  if (svc.installed) {
    // REINSTALL the unit, do not merely advise a restart. Two reasons, both measured on
    // testbed. The unit inlines its template AND the env at service-install time, so a
    // fix shipped in a release (Restart=on-failure -> always was one; the self-update
    // handover exits 0 and an on-failure unit stays DEAD after every upgrade) never
    // reaches an existing install through a restart. And the advice route ends with a
    // pilot who did everything `update` said and still has a dead shipper.
    // service.js install is idempotent: same home replaces in place and starts it.
    try {
      const svcmod = require(path.join(REPO_ROOT, 'memhouse', 'service.js'));
      // Keep the interval the pilot chose. The refresh used to hardcode 300, silently
      // rewriting a `service install --interval 30` unit on every update.
      let interval = 300;
      try {
        const unit = fs.readFileSync(require('path').join(os.homedir(), '.config', 'systemd', 'user', 'memhouse-shipper.service'), 'utf-8');
        const m = unit.match(/--loop['" ]+(\d+)/);
        if (m) interval = Number(m[1]);
      } catch { /* launchd or missing: fall through to plist */ }
      try {
        if (interval === 300 && process.platform === 'darwin') {
          const plist = fs.readFileSync(require('path').join(os.homedir(), 'Library', 'LaunchAgents', 'com.memhouse.shipper.plist'), 'utf-8');
          const m = plist.match(/--loop<\/string>\s*<string>(\d+)/);
          if (m) interval = Number(m[1]);
        }
      } catch { /* keep default */ }
      const r = svcmod.install({ shipJs: SHIP_JS, envFile: ENV_FILE, logDir: LOG_DIR, interval, home: HOME_DIR });
      if (r.ok) console.log(ok(`service unit refreshed and restarted (${r.kind})`));
      else {
        console.log(warn(`could not refresh the service unit: ${r.msg}`));
        console.log(svc.kind === 'systemd'
          ? '  restart it yourself: systemctl --user restart memhouse-shipper'
          : '  restart it yourself: launchctl kickstart -k gui/$(id -u)/com.memhouse.shipper');
      }
    } catch (e) {
      console.log(warn(`could not refresh the service unit: ${e.message}`));
    }
  }
  if (wasRunning.shipper || wasRunning.dashboard) {
    cmdStop();
    await cmdStart();
  } else if (!svc.installed) {
    console.log(warn('no daemons were running — start them with: memhouse start'));
  }

  // The new release may need the HOUSE moved too, and upgrade time is when the pilot is
  // watching — a migration named here beats one discovered as a refusing service in a log
  // nobody reads. Three behaviours, chosen by the pilot:
  //   memhouse update --migrate   run whatever is pending, unasked (--yes implies it)
  //   interactive                 name what is pending and ask
  //   non-interactive, no flag    name it and print the command; NEVER auto-run — a cron
  //                               or CI invocation must not start a house-wide copy
  const cfg = resolveConfig();
  if (cfg.url && cfg.user) {
    try {
      const r = await roomsFor(cfg);
      const tpl = fs.readFileSync(path.join(REPO_ROOT, 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
      const mig = require(path.join(REPO_ROOT, 'memhouse', 'house', 'migrate.js'));
      const q = {
        sql: (sql, settings) => ch(cfg, sql, { settings }),
        rows: (sql, settings) => chRows(cfg, sql, settings ? { settings } : undefined),
      };
      const pending = await mig.detectPending(q, { db: cfg.db, tpl, rooms: r, member: r.member });
      if (pending.length) {
        console.log(warn(`this release needs ${pending.length} migration(s) the house has not had:`));
        for (const x of pending) console.log(`     ${x.migration.id} (schema ${x.migration.toVersion}, ${x.migration.component})`);
        let go = flags.migrate === true || flags.yes === true;
        if (!go && process.stdin.isTTY) {
          const a = (await ask('Run them now? (yes/no)', 'no')).toLowerCase();
          go = a === 'yes' || a === 'y';
        }
        if (go) {
          const code = await cmdMigrate({ quiet: true, assumeYes: true });
          if (code !== 0) return code;
        } else {
          console.log(warn('until they run, the shipper REFUSES every pass (nothing is lost, nothing ships):'));
          console.log('     memhouse migrate');
        }
      }
    } catch (e) {
      // An unreachable house is not an upgrade failure — the files are updated either way.
      console.log(warn(`could not check the house for pending migrations: ${e.message.split('\n')[0]}`));
    }
    // The column healer half: additive drift the migrations above do not cover.
    const code = run(SHIP_JS, ['--ensure-schema'], cfg);
    if (code !== 0) { console.log(warn('the house schema needs attention — memhouse doctor')); return code; }
  }
  return 0;
}

// Every Claude Code instance on this machine, not just the default one.
//
// A pilot rarely has one. `~/.claude` is the stock install, `CLAUDE_CONFIG_DIR` points at
// whichever they are running right now, and Kommander-style playbooks live under
// `~/.claude-playbooks/<name>[/playbook]`, each a complete config directory with its own
// skills/. Installing into one and calling it done leaves /mem:recall missing from
// every other instance the pilot uses — silently, because a missing skill does not announce
// itself, it just never appears.
//
// The discovery is the ADAPTER's (editors/claude.js discoverClaudeRoots), reused rather
// than reimplemented: it already ports memory-house's discover_roots and runs on every
// ship. A second copy here would drift the first time a playbook layout changes — which is
// the same defect this repo just retired in install.sh.
function claudeTargets() {
  const seen = new Map(); // realpath -> { dir, why }
  const add = (dir, why) => {
    if (!dir) return;
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
    if (!isDir) return;
    let rp; try { rp = fs.realpathSync(dir); } catch { rp = dir; }
    if (!seen.has(rp)) seen.set(rp, { dir, why });
  };
  // The instance the caller is running under comes first, and is NOT subject to the
  // adapter's "has this been used?" test — a fresh config dir has no projects/ yet, and it
  // is exactly where the pilot wants the skills.
  add(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR');
  add(path.join(os.homedir(), '.claude'), 'default');
  try {
    const { discoverClaudeRoots } = require(path.join(REPO_ROOT, 'editors', 'claude'));
    for (const r of discoverClaudeRoots()) add(r, 'playbook');
  } catch { /* adapter unavailable — the two above still stand */ }
  return [...seen.values()];
}

const short = (p) => p.replace(os.homedir(), '~');
const PLUGIN_MARK = path.join('skills', 'mem', '.claude-plugin', 'plugin.json');
const isPluginInstalled = (dir) => fs.existsSync(path.join(dir, PLUGIN_MARK));

function installPluginInto(dir) {
  // The plugin was named `memhouse` until 0.10.0. A leftover copy under the old name
  // would load BESIDE the new one — /memhouse:search and /mem:recall both resolving, one
  // of them stale forever. Remove it only when it is provably OURS (it carries our
  // plugin.json); a directory someone else named `memhouse` is not ours to delete.
  const legacy = path.join(dir, 'skills', 'memhouse');
  const legacyManifest = path.join(legacy, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(legacyManifest)) {
    let lname = null;
    try { lname = JSON.parse(fs.readFileSync(legacyManifest, 'utf-8')).name; } catch { /* unreadable */ }
    if (lname === 'memhouse' || lname === 'mem') {
      fs.rmSync(legacy, { recursive: true });
      console.log(ok(`removed the pre-0.10 plugin at ${short(legacy)} (renamed to 'mem')`));
    }
  }
  const dst = path.join(dir, 'skills', 'mem');
  // REPLACE, not overlay. cpSync over an existing install refreshes the skills and
  // leaves anything else standing — a machine that once had a build with extra skills
  // kept offering /mem:replay and /mem:house forever, stale, beside the real ones.
  // Ownership means OUR MANIFEST, checked by name — "any plugin.json" would have deleted
  // an unrelated plugin that happened to pick the same directory name.
  const dstManifest = path.join(dst, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(dstManifest)) {
    let name = null;
    try { name = JSON.parse(fs.readFileSync(dstManifest, 'utf-8')).name; } catch { /* unreadable */ }
    if (name === 'mem' || name === 'memhouse') fs.rmSync(dst, { recursive: true });
    else throw new Error(`skills/mem in ${dir} belongs to plugin '${name || '(unreadable manifest)'}' — refusing to replace it`);
  }
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(DELIVERY, 'plugin'), dst, { recursive: true });
  // Stamp the manifest with THIS memhouse's version. The source plugin.json carries a
  // FROZEN number — it sat at 0.11.0 through several releases, so every install
  // advertised the wrong version (`memhouse --version` said one thing, the plugin
  // another). The package version is the single truth; write it into the copy.
  try {
    const m = JSON.parse(fs.readFileSync(dstManifest, 'utf-8'));
    if (m.version !== PKG.version) {
      m.version = PKG.version;
      fs.writeFileSync(dstManifest, `${JSON.stringify(m, null, 2)}\n`);
    }
  } catch { /* manifest unreadable — leave the copied one rather than guess */ }
  return dst;
}

// Which instances to act on. EVERYTHING IS SELECTED BY DEFAULT: with several Claude
// installs the answer is almost always "all of them", and a pilot who wanted one would have
// passed --target. Numbers narrow it, 'n' skips.
//
// No prompt at all when there is nothing to choose (one target), when an agent is driving
// (--yes / --json), or when there is no terminal to answer with — a blocked prompt in a
// script is a hang, not a question.
async function chooseTargets(targets, verb) {
  if (targets.length === 1 || flags.yes === true || JSON_OUT || !process.stdin.isTTY) return targets;
  console.log('');
  targets.forEach((t, i) => {
    const state = isPluginInstalled(t.dir) ? 'already installed — will be refreshed' : t.why;
    console.log(`  ${i + 1}) ${short(t.dir)}  (${state})`);
  });
  const a = (await ask(`${verb} all ${targets.length}? (Y/n, or numbers like "1 3")`, 'Y')).trim().toLowerCase();
  if (a === 'n' || a === 'no') return [];
  if (a === 'y' || a === 'yes' || a === '') return targets;
  const picked = [...new Set(a.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= targets.length))];
  // An unparseable answer must not quietly mean "all" — that would install into places the
  // pilot was in the middle of narrowing down. Say so and take none.
  if (!picked.length) { console.log(warn(`did not understand '${a}' — nothing selected`)); return []; }
  return picked.map((n) => targets[n - 1]);
}

// Install the skills as a PLUGIN, not as three loose skill directories.
//
// Claude Code gives a skill a namespace only when it arrives inside a plugin: a directory
// under <config>/skills/ containing .claude-plugin/plugin.json loads as
// `mem@skills-dir` and its skills become /mem:recall,
// /mem:sql. Copied in flat, the same three files register as unrelated top-level
// skills named after their folders — which is what this used to do, while plugin.json sat
// unread one directory away claiming the colon form. Driving a real Claude Code is what
// caught it: `/mem:recall` answered `Unknown command. Did you mean /memhouse-search?`
/**
 * The plugin's skills, by name. A directory is a skill only when it carries a SKILL.md —
 * `plugin/` also holds `reference/`, shared prose the skills point at, and listing that
 * as `/mem:reference` would advertise a command nobody can run.
 */
function skillNames() {
  const dir = path.join(DELIVERY, 'plugin', 'skills');
  try {
    return fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md'))).sort();
  } catch { return []; }
}

async function cmdPlugins() {
  const sub = positional[0] || 'list';
  const pluginSrc = path.join(DELIVERY, 'plugin');
  const names = skillNames();   // SKILL.md-bearing dirs only — `reference/` is not a skill
  const invocations = names.map((n) => `/mem:${n}`).join(', ');
  // --target overrides the discovery rather than joining it: given one, that is the only
  // directory touched.
  const targets = flags.target ? [{ dir: flags.target, why: '--target' }] : claudeTargets();
  // Whatever --target was given has to reappear in the advice, or pasting it installs
  // somewhere else than the directory just inspected.
  const self = `memhouse plugins install claude${flags.target ? ` --target ${flags.target}` : ''}`;

  if (sub === 'list') {
    console.log(`skills available: ${invocations}`);
    if (!targets.length) { console.log(warn('no Claude Code config directory found')); return 0; }
    for (const t of targets) {
      console.log(isPluginInstalled(t.dir)
        ? ok(`installed in ${short(t.dir)} (${t.why})`)
        : warn(`not installed in ${short(t.dir)} (${t.why})`));
    }
    if (!targets.some((t) => isPluginInstalled(t.dir))) console.log(`  install with: ${self}`);
    return 0;
  }

  if (sub === 'install' && positional[1] === 'claude') {
    if (!targets.length) {
      console.log(warn('no Claude Code config directory found — nothing to install into'));
      console.log('  name one explicitly with --target DIR');
      return 1;
    }
    const chosen = await chooseTargets(targets, 'Install');
    if (!chosen.length) { console.log(warn('nothing installed')); return 0; }
    for (const t of chosen) console.log(ok(`installed ${names.length} skills into ${short(installPluginInto(t.dir))}`));
    console.log(`  loads as mem@skills-dir next session — invoke ${invocations}`);
    return 0;
  }

  if (sub === 'remove' && positional[1] === 'claude') {
    const installed = targets.filter((t) => isPluginInstalled(t.dir));
    if (!installed.length) { console.log(warn('nothing installed in any Claude config directory')); return 0; }
    const chosen = await chooseTargets(installed, 'Remove from');
    if (!chosen.length) { console.log(warn('nothing removed')); return 0; }
    for (const t of chosen) {
      fs.rmSync(path.join(t.dir, 'skills', 'mem'), { recursive: true });
      // Remove the now-empty skills/ we created, but never a skills/ holding someone
      // else's work.
      try { fs.rmdirSync(path.join(t.dir, 'skills')); } catch { /* not empty: leave it */ }
      console.log(ok(`removed ${short(path.join(t.dir, 'skills', 'mem'))}`));
    }
    return 0;
  }

  console.log('usage: memhouse plugins [list | install claude | remove claude] [--target DIR] [--yes]');
  return 2;
}

async function cmdReset() {
  const cfg = requireConfig(resolveConfig(), 'reset');
  const r = await roomsFor(cfg);
  const targets = ROOM_TYPES.map((t) => r[`${t}_raw`]);

  // Imported rows are NOT the shipper's to remove, and reset is a re-ship: whatever it
  // deletes has to be something re-shipping puts back. An import cannot be — it came from
  // an older house, another product, or a machine that no longer exists. Scoped to
  // origin='ship' by default, therefore, exactly like the shipper, which supersedes only its own rows.
  //
  // This path was missed when that clear was fixed, and it is the one place the 0.4.4 data
  // loss survived: `reset --yes` took a house from 2 imported rows to 0 while the prompt
  // said only "truncates … and re-ships". --all-origins still allows it, but nobody
  // reaches it by accident, and the count is named before it happens.
  const allOrigins = flags['all-origins'] === true;
  let imported = 0;
  try {
    // Same predicate the DELETE uses. Counted without an owner filter, this warned
    // "removing 2 imported row(s)" and then removed none of them — rows imported by an
    // ADMIN during a migration carry the admin's user_id, so a member's DELETE cannot
    // reach them. The prompt was wrong in the alarming direction.
    const esc0 = (await chRows(cfg, 'SELECT currentUser() AS u'))[0]?.u?.replace(/\\/g, '\\\\').replace(/'/g, "\\'") || '';
    const counts = await Promise.all(targets.map(async (t) =>
      Number((await chRows(cfg, `SELECT count() AS c FROM ${t} FINAL WHERE origin != 'ship' AND (user_id = '${esc0}' OR user_id = '')`))[0]?.c || 0)));
    imported = counts.reduce((a, b) => a + b, 0);
  } catch { /* pre-origin house: nothing to protect, ensureSchema will add the column */ }

  if (flags.yes !== true) {
    // Name the rooms, and the scope honestly: the tables are shared, but reset only ever
    // deletes rows whose user_id is the CALLER's — a housemate's rows are untouched.
    const scope = allOrigins
      ? `EVERY row, including ${imported} imported one(s) that re-shipping CANNOT restore,`
      : 'the rows the shipper wrote';
    const a = (await ask(`This clears ${scope} from ${targets.join(', ')} in '${cfg.db}' and re-ships. Continue? (yes/no)`, 'no')).toLowerCase();
    if (a !== 'yes' && a !== 'y') return console.log('aborted'), 1;
  }
  if (allOrigins && imported) console.log(warn(`removing ${imported} imported row(s) — re-shipping will not bring them back`));
  else if (imported) console.log(`  keeping ${imported} imported row(s) (--all-origins removes them too)`);
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
  const originScope = allOrigins ? '' : " AND origin = 'ship'";
  // `OR user_id = ''` because rows written under async_insert=1 never got the
  // MATERIALIZED currentUser() stamp, and a DELETE bound to the caller's name cannot
  // reach them — so `reset --all-origins`, whose prompt says "EVERY row", left them
  // behind and only an admin could clear them. Safe to include here and nowhere else:
  // these rooms are named for one member, so an unattributed row IN THIS ROOM is theirs
  // by construction. The shipper's per-session clear deliberately does NOT do this — it
  // only ever removes what it wrote, and it always writes with async_insert=0.
  const owner = `(user_id = '${esc}' OR user_id = '')`;
  for (const t of targets) await ch(cfg, `DELETE FROM ${t} WHERE ${owner}${originScope}`);
  console.log(ok(`cleared ${uid}'s ${allOrigins ? '' : 'shipped '}rows from ${targets.join(', ')}`));
  return run(SHIP_JS, ['--full'], cfg);
}

// ── the house's record of itself ────────────────────────────────────────────────
const sqlStr = (s) => `'${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Append one row to house_events. Never fatal: paperwork must not stop a migration. */
async function houseEvent(cfg, e) {
  const cols = ['kind', 'id', 'status', 'from_version', 'to_version', 'host', 'rows_before', 'rows_after', 'detail'];
  // Numeric columns render as 0 when absent, NEVER as ''. An event without rows_after —
  // which is every pending and every failed row — rendered '' into a UInt64, ClickHouse
  // refused the whole INSERT, and the catch below swallowed it: the ledger silently held
  // only applied rows, so unfinishedBy() could never see a pending marker and the
  // concurrent-migrator lock never engaged. Found by reading the ledger after a real
  // refused migration and counting two rows where six belonged.
  const NUMERIC = new Set(['rows_before', 'rows_after']);
  const vals = cols.map((c) => (NUMERIC.has(c)
    ? String(Number(e[c]) || 0)
    : sqlStr(e[c] || '')));
  try {
    await ch(cfg, `INSERT INTO ${physicalRoom('house_events', cfg.user)} (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
      { settings: { async_insert: 0 } });
  } catch { /* an unwritable log is not a reason to abandon a rebuild */ }
}

async function houseMeta(cfg, key, value) {
  try {
    await ch(cfg, `INSERT INTO ${physicalRoom('house_meta', cfg.user)} (key, value) VALUES (${sqlStr(key)}, ${sqlStr(value)})`,
      { settings: { async_insert: 0 } });
  } catch { /* same */ }
}

/**
 * `memhouse migrate [--dry-run] [--yes]` — run whatever migrations this house still
 * needs, in order. `memhouse migrate-rooms` is the same runner filtered to the 'rooms'
 * component; the name stays because other components (a daemon, config layouts) will
 * carry their own migrations one day and "migrate-rooms" will then mean exactly what it
 * says.
 *
 * The machinery — registry, detection, executors, and the invariants every migration
 * inherits (nothing deleted, provenance never restamped, atomic swap, late writes
 * survive, everything recorded) — lives in memhouse/house/migrate.js. This function is
 * transport and conversation: build the q/ledger adapters, show the plan, ask, run.
 */
async function cmdMigrate({ component = null, quiet = false, assumeYes = false } = {}) {
  const cfg = requireConfig(resolveConfig(), component === 'rooms' ? 'migrate-rooms' : 'migrate');
  // The db name is spliced into system-table predicates and DDL below. install validates
  // it at creation; this validates what an env FILE says, which a hand edit can break.
  try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(cfg.db, 'house'); }
  catch (e) { console.log(bad(e.message)); return 1; }
  const r = await roomsFor(cfg);
  const tpl = fs.readFileSync(path.join(REPO_ROOT, 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
  const host = require(path.join(REPO_ROOT, 'memhouse', 'host.js')).identity().id;
  const mig = require(path.join(REPO_ROOT, 'memhouse', 'house', 'migrate.js'));

  const q = {
    sql: (sql, settings) => ch(cfg, sql, { settings }),
    rows: (sql, settings) => chRows(cfg, sql, settings ? { settings } : undefined),
  };
  const ctx = { db: cfg.db, tpl, rooms: r, host, member: r.member };
  const ledger = { event: (e) => houseEvent(cfg, e), meta: (k, v) => houseMeta(cfg, k, v) };
  const ui = { ok: (m) => console.log(ok(m)), warn: (m) => console.log(warn(m)) };

  // Detection first, and NOTHING written before the dry-run gate: detect() reads only
  // system tables, so a --dry-run (and an already-current house under --dry-run) truly
  // changes nothing — the earlier order created the meta tables and stamped
  // schema_version on the way to saying "nothing was changed".
  // Read the recorded generation BEFORE anything else. This binary knows migrations up
  // to SCHEMA_VERSION; a house recorded ABOVE that was moved forward by a newer release,
  // and the two stamps at the bottom of this function would have quietly REWOUND its
  // record (schema 3 -> 2) — defeating the writer guard for every old shipper whose key
  // shapes happen to match. An older memhouse cannot migrate a newer house, only say so.
  try {
    const rec = await q.rows(`SELECT value FROM ${physicalRoom('house_meta', cfg.user)} FINAL WHERE key = 'schema_version'`);
    const recorded = rec.length ? Number(rec[0].value) || 0 : 0;
    if (recorded > SCHEMA_VERSION) {
      console.log(bad(`this house is at schema ${recorded}; this memhouse knows migrations up to ${SCHEMA_VERSION}.`));
      console.log('  A newer release moved it forward. Update THIS machine:  memhouse update');
      return 1;
    }
  } catch { /* no record yet — a pre-0.10 house; detection below owns it */ }

  const pending = await mig.detectPending(q, ctx, { component });

  if (flags['dry-run'] === true) {
    if (!pending.length) { console.log(ok(`nothing to migrate — the house is at schema ${SCHEMA_VERSION}`)); return 0; }
    for (const item of pending) {
      for (const line of item.migration.plan(item.found)) console.log(line);
      console.log('');
    }
    console.log(warn(`dry run — ${pending.length} migration(s) pending, nothing was changed`));
    return 0;
  }

  // The house's record of itself, created here if absent — a pre-0.10 house has none,
  // and a migration is precisely the event those tables exist to record. Best-effort: a
  // member without CREATE TABLE can still be the one who notices the rooms need
  // rebuilding, and the rebuild matters more than the paperwork.
  const { META_TYPES: metas } = require(path.join(REPO_ROOT, 'memhouse', 'house', 'house'));
  for (const t of metas) {
    try {
      await ch(cfg, createStatement(tpl, t, t).replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
    } catch { /* no rights, or already there */ }
  }

  if (!pending.length) {
    if (!quiet) console.log(ok(`nothing to migrate — the house is at schema ${SCHEMA_VERSION}`));
    await houseMeta(cfg, 'schema_version', String(SCHEMA_VERSION));
    return 0;
  }

  for (const item of pending) {
    for (const line of item.migration.plan(item.found)) console.log(line);
    console.log('');
  }

  // Another actor mid-copy: two concurrent rebuilds of one room end with one of them
  // renaming the other's work.
  for (const item of pending) {
    const busy = await mig.unfinishedBy(q, ctx, item.migration.id);
    if (busy) {
      console.log(bad(`migration ${item.migration.id} is already pending by '${busy.actor}' (since ${busy.at})`));
      console.log('  if that run is dead, its __migrating leftovers say so — inspect, clean, retry.');
      return 1;
    }
  }

  const svc = shipperHealth();
  if (svc.running) {
    console.log(warn(`the shipper is running (${svc.via}) — rows it writes during the copy are picked up`));
    console.log('  by a second pass, but stopping it first makes the migration a single, quiet copy:');
    // The REAL command for how it is actually managed. This used to print
    // `memhouse service stop`, which did not exist — the dispatcher showed status.
    console.log(String(svc.via || '').startsWith('service')
      ? (process.platform === 'darwin'
        ? '  launchctl bootout gui/$(id -u)/com.memhouse.shipper   (memhouse service install brings it back)'
        : '  systemctl --user stop memhouse-shipper   (systemctl --user start … brings it back)')
      : '  memhouse stop');
  }
  // The one writer this migration CANNOT make safe is an old memhouse on ANOTHER machine.
  // A 0.9.0 shipper passes its own key check against the migrated rooms (it only looks
  // for `origin`) and keeps writing — harmless — but its per-session DELETE clear removes
  // a re-shipped session's rows across ALL epochs, destroying exactly the superseded
  // parses this schema exists to keep. Say so here, where the pilot is looking.
  console.log(warn('if OTHER machines ship into this house as you, upgrade them promptly:'));
  console.log('  a pre-0.10 shipper elsewhere still deletes before re-inserting, and on the');
  console.log('  migrated rooms that delete reaches every retained parse of a session it re-ships.');
  // assumeYes carries a consent ALREADY GIVEN one level up — `update` prompted (or took
  // --migrate/--yes) before calling here, and asking twice teaches pilots that prompts
  // are noise. It is never set on a direct `memhouse migrate`.
  if (flags.yes !== true && !assumeYes) {
    const what = pending.map((x) => x.migration.id).join(', ');
    const a = (await ask(`Run ${pending.length} migration(s) (${what}) on '${cfg.db}'? (yes/no)`, 'no')).toLowerCase();
    if (a !== 'yes' && a !== 'y') return console.log('aborted'), 1;
    // Re-check AFTER the prompt: it is where a second migrator sits while the first one's
    // pending marker lands. Checked only before it, two `memhouse update`s both saw a
    // clean ledger, both got a yes, and both proceeded.
    for (const item of pending) {
      const busy = await mig.unfinishedBy(q, ctx, item.migration.id);
      if (busy) {
        console.log(bad(`while you decided, '${busy.actor}' started ${item.migration.id} (${busy.at}) — standing down.`));
        return 1;
      }
    }
  }

  for (const item of pending) {
    try {
      await mig.runMigration(q, ctx, item, { ledger, ui });
    } catch (e) {
      console.log(bad(`${item.migration.id}: ${e.message}`));
      console.log('  what completed stands (house_events per room says which); what failed was not swapped.');
      console.log(`  a partial copy may sit in <room>__migrating — inspect before dropping. Re-run when fixed:`);
      console.log('     memhouse migrate');
      return 1;
    }
  }

  // The floor under future writers: any 0.10+ memhouse reads this at pass start and
  // refuses if it is too old for the house. Pre-0.10 releases read nothing — hence the
  // REVOKE advice below, which is the only enforcement that reaches them.
  await houseMeta(cfg, 'min_writer_schema', String(MIN_WRITER_SCHEMA));

  console.log(`\n${ok(`house is at schema ${SCHEMA_VERSION}`)}`);
  console.log('  verify with: memhouse doctor');
  console.log(`  then, when you are satisfied: DROP TABLE ${cfg.db}.<room>_pre_epoch`);
  console.log('');
  console.log(warn('machines still on an older memhouse cannot be stopped by code — they never read'));
  console.log('  this house\'s record. If any exist, either upgrade them now or take away the one');
  console.log('  privilege whose misuse loses data (their shipping breaks LOUDLY instead of deleting');
  console.log('  retained parses silently):');
  console.log(`     REVOKE ALTER DELETE, ALTER UPDATE ON ${cfg.db}.* FROM <member>   -- per member, as admin`);
  console.log('  Nothing in 0.10+ needs those grants except the interactive `memhouse reset`.');
  return 0;
}

/**
 * `memhouse relocate --to <url>` — copy a whole house to a NEW ClickHouse, server-to-
 * server, then repoint this install at it. The point is to move WITHOUT the shipper
 * re-ingesting: once the new host holds a faithful copy, the shipper's skip predicate
 * sees every old session already present and ships only genuinely new work.
 *
 * The copy is a ClickHouse remoteSecure() INSERT SELECT — the destination pulls each room
 * directly from the source over the native protocol; the pilot's laptop is never in the
 * data path. Provenance is carried, not restamped (insert_allow_materialized_columns=1),
 * exactly as `migrate`'s rebuildRoom does, so a shared house keeps every member's user_id.
 *
 * Nothing on the SOURCE is touched — relocate only reads it and only writes the
 * destination and the local env file, so a failed run leaves the old house intact.
 *
 * SECURITY: the source password is spliced into the remoteSecure() call, which runs on
 * the DESTINATION and lands in ITS query_log. Two consequences, both stated to the pilot:
 * it never touches THIS transcript (the SQL is never printed), but rotate the source
 * credential afterward if the destination's logs are not yours to trust.
 *
 * Flags: --to (required), --to-user/--to-password/--to-db (default: the source's),
 * --from-native-port (default 9440), --insecure-native (remote()+9000, no TLS),
 * --keep-shipper (don't stop it for the copy), --dry-run, --yes.
 */
async function cmdRelocate() {
  const rel = require(path.join(REPO_ROOT, 'memhouse', 'house', 'relocate.js'));
  const house = require(path.join(REPO_ROOT, 'memhouse', 'house', 'house'));
  const stated = (f) => flags[f] !== undefined && flags[f] !== true;

  const to = flags.to;
  if (!to || to === true) { console.log(bad('relocate needs a destination:  memhouse relocate --to <url>')); return 1; }
  const src = requireConfig(resolveConfig(), 'relocate');
  const dest = {
    url: to,
    user: stated('to-user') ? flags['to-user'] : src.user,
    password: stated('to-password') ? flags['to-password'] : src.password,
    db: stated('to-db') ? flags['to-db'] : src.db,
    port: src.port, stated: true,
  };
  if (sameEndpoint(src.url, dest.url)) {
    console.log(bad(`source and destination are the same server (${dest.url}) — nothing to relocate`)); return 1;
  }
  for (const [n, who] of [[src.db, 'source house'], [dest.db, 'destination house']]) {
    try { house.assertUsableName(n, who); } catch (e) { console.log(bad(e.message)); return 1; }
  }

  const sq = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const bq = (s) => `\`${String(s).replace(/`/g, '``')}\``;
  const tpl = fs.readFileSync(path.join(REPO_ROOT, 'memhouse', 'house', 'schema.sql.tpl'), 'utf-8');
  let nat;
  try {
    nat = rel.nativeEndpoint(src.url, {
      host: stated('from-native-host') ? flags['from-native-host'] : null,
      port: stated('from-native-port') ? flags['from-native-port'] : null,
      insecure: flags['insecure-native'] === true,
    });
  } catch (e) { console.log(bad(e.message)); return 1; }

  const countFinal = async (cfg, t) => Number((await chRows(cfg, `SELECT count() AS c FROM ${bq(t)}`, { database: cfg.db }))[0]?.c || 0);

  // ── preflight: source reachable, current schema, and its counts ──────────────────
  let srcMember;
  try { srcMember = (await chRows(src, 'SELECT currentUser() AS u', { database: '' }))[0]?.u; }
  catch (e) { console.log(bad(`source not reachable: ${netReason(e)}`)); return 1; }
  try {
    const rec = await chRows(src, `SELECT value FROM ${physicalRoom('house_meta', src.user)} FINAL WHERE key = 'schema_version'`, { database: src.db });
    const v = rec.length ? Number(rec[0].value) || 0 : 0;
    if (v !== SCHEMA_VERSION) {
      console.log(bad(`source house is at schema ${v || 'pre-record'}; this memhouse is ${SCHEMA_VERSION}.`));
      console.log('  Migrate the source first, then relocate:  memhouse migrate');
      return 1;
    }
  } catch {
    console.log(bad('source house has no house_meta — migrate it first:  memhouse migrate'));
    return 1;
  }
  const base = {};
  for (const t of ROOM_TYPES) base[t] = await countFinal(src, t);

  // ── preflight: destination reachable ─────────────────────────────────────────────
  let destMember;
  try { destMember = (await chRows(dest, 'SELECT currentUser() AS u', { database: '' }))[0]?.u; }
  catch (e) { console.log(bad(`destination not reachable: ${netReason(e)}`)); return 1; }

  console.log(`  relocate  ${src.user}@${new URL(src.url).host} (house '${src.db}')`);
  console.log(`        ->  ${dest.user}@${new URL(dest.url).host} (house '${dest.db}')`);
  console.log(`  source rooms: sessions ${base.sessions}, messages ${base.messages}, tool_calls ${base.tool_calls}`);
  console.log(`  copy transport: ${nat.fn}(${nat.addr})  [source password never printed]`);

  if (flags['dry-run'] === true) {
    console.log(warn('dry run — nothing was created, copied, or repointed'));
    return 0;
  }
  if (flags.yes !== true) {
    const a = (await ask(`Copy this house to ${new URL(dest.url).host} and repoint this install? (yes/no)`, 'no')).toLowerCase();
    if (a !== 'yes' && a !== 'y') return console.log('aborted'), 1;
  }

  // ── freeze the source shipper (best-effort) ──────────────────────────────────────
  let restart = null;
  const health = shipperHealth();
  if (health.running && flags['keep-shipper'] !== true) {
    if (String(health.via || '').startsWith('service')) {
      const svc = require(path.join(REPO_ROOT, 'memhouse', 'service.js'));
      const st = svc.status();
      const stop = st.kind === 'systemd'
        ? ['systemctl', ['--user', 'stop', 'memhouse-shipper']]
        : ['launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.shipper`]];
      const r = spawnSync(stop[0], stop[1], { stdio: 'pipe', encoding: 'utf-8' });
      if (r.status === 0) { console.log(ok('shipper stopped for the copy')); restart = { kind: 'service', st }; }
      else console.log(warn(`could not stop the shipper (${(r.stderr || '').trim().split('\n')[0] || 'exit ' + r.status}); continuing — late writes dedupe`));
    } else {
      const pid = pidOf('shipper');
      if (pid) { try { process.kill(pid, 'SIGTERM'); console.log(ok(`shipper daemon stopped (pid ${pid})`)); restart = { kind: 'daemon' }; } catch { /* raced */ } }
    }
  }

  try {
    // ── schema on the destination (no ingest) ──────────────────────────────────────
    await ch(dest, `CREATE DATABASE IF NOT EXISTS ${bq(dest.db)}`, { database: '' });
    for (const t of [...META_TYPES, ...ROOM_TYPES]) {
      await ch(dest, createStatement(tpl, t, t).replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '),
        { database: dest.db, settings: { allow_experimental_full_text_index: 1 } });
    }
    const destBefore = await countFinal(dest, 'messages');
    if (destBefore > 0 && flags.yes !== true) {
      console.log(warn(`destination already holds ${destBefore} messages — copy is idempotent (ReplacingMergeTree dedupes), continuing`));
    }

    // ── probe native reachability BEFORE the big copy (never logs the password) ─────
    const probe = `SELECT count() AS c FROM ${nat.fn}(${sq(nat.addr)}, ${sq(src.db)}, 'sessions', ${sq(src.user)}, ${sq(src.password)})`;
    try { await chRows(dest, probe, { database: dest.db, timeout: 60000 }); }
    catch (e) {
      console.log(bad(`the destination cannot reach the source over ${nat.fn} at ${nat.addr}: ${netReason(e)}`));
      console.log('  open the source native port (default 9440 TLS), or pass --from-native-port / --insecure-native.');
      throw new Error('relocate-preflight');
    }

    // ── copy each table, provenance carried ────────────────────────────────────────
    for (const t of [...ROOM_TYPES, ...META_TYPES]) {
      const destCols = (await chRows(dest, `SELECT name FROM system.columns WHERE database = ${sq(dest.db)} AND table = ${sq(t)}`, { database: dest.db })).map((r) => r.name);
      const srcCols = (await chRows(src, `SELECT name FROM system.columns WHERE database = ${sq(src.db)} AND table = ${sq(t)}`, { database: src.db })).map((r) => r.name);
      const cols = rel.copyColumns(destCols, srcCols);
      if (!cols.length) { console.log(warn(`${t}: no shared columns — skipped`)); continue; }
      const list = cols.map(bq).join(', ');
      // house_meta carries only durable facts; the per-host heartbeats regenerate.
      const where = t === 'house_meta'
        ? " WHERE key IN ('schema_version','min_writer_schema','house_id') OR key LIKE 'share:%'" : '';
      const copySql = `INSERT INTO ${bq(t)} (${list}) SELECT ${list} FROM ${nat.fn}(${sq(nat.addr)}, ${sq(src.db)}, ${sq(t)}, ${sq(src.user)}, ${sq(src.password)})${where}`
        + ' SETTINGS insert_allow_materialized_columns = 1, allow_experimental_full_text_index = 1';
      await ch(dest, copySql, { database: dest.db, timeout: 3600000 });
      console.log(ok(`${t}: copied`));
    }

    // ── verify — the hard gate before repointing ───────────────────────────────────
    let allGood = true;
    for (const t of ROOM_TYPES) {
      const d = await countFinal(dest, t);
      const good = d >= base[t];
      console.log((good ? ok : bad)(`${t}: source ${base[t]} -> dest ${d}`));
      if (!good) allGood = false;
    }
    if (!allGood) {
      console.log(bad('row counts do not match — NOT repointing. The source is untouched; inspect the destination.'));
      throw new Error('relocate-verify');
    }

    // ── repoint the local config (old env kept alongside) ──────────────────────────
    try { fs.copyFileSync(ENV_FILE, `${ENV_FILE}.pre-relocate`); console.log(ok(`previous config kept at ${`${ENV_FILE}.pre-relocate`.replace(os.homedir(), '~')}`)); }
    catch { /* no prior env file — first config */ }
    writeEnvFile(dest);
    console.log(ok(`config repointed to ${dest.url} (house '${dest.db}')`));
  } catch (e) {
    if (!['relocate-preflight', 'relocate-verify'].includes(e.message)) console.log(bad(`relocate failed: ${e.message.split('\n')[0]}`));
    console.log(warn('the SOURCE house was not touched — your data is safe there.'));
    if (restart) console.log(warn('the shipper was stopped; restart it:  memhouse service start   (or  memhouse start)'));
    return 1;
  }

  // ── restart the shipper against the new host ─────────────────────────────────────
  if (restart) {
    if (restart.kind === 'service') {
      const st = restart.st;
      const start = st.kind === 'systemd'
        ? ['systemctl', ['--user', 'start', 'memhouse-shipper']]
        : ['launchctl', ['bootstrap', `gui/${process.getuid()}`, st.path]];
      const r = spawnSync(start[0], start[1], { stdio: 'pipe', encoding: 'utf-8' });
      console.log(r.status === 0 ? ok('shipper restarted — now writing to the new host')
        : warn('restart the shipper yourself:  memhouse service start'));
    } else {
      console.log(warn('restart the shipper to pick up the new host:  memhouse start  (or  memhouse service start)'));
    }
  } else if (shipperHealth().running) {
    console.log(warn('a shipper is still running against the OLD host — restart it to pick up the new config.'));
  }

  console.log('');
  console.log(ok('relocate complete.'));
  console.log('  the shipper will NOT re-ingest: every copied session is already present, so its');
  console.log('  skip predicate ships only new work from here.');
  console.log('  verify:  memhouse status');
  console.log('  keep the OLD house until you are satisfied, then decommission it.');
  if (!flags['insecure-native']) console.log(warn('the source password reached the destination server (its query_log) — rotate it if those logs are not yours to trust.'));
  return 0;
}

/**
 * `memhouse nightly [--out DIR]` — build an installable, version-stamped tarball from
 * this checkout, without publishing anything.
 *
 * What it automates is exactly the by-hand recipe: stamp package.json with
 * <base>-nightly.<YYYYMMDD.HHMM>, `npm pack` (prepack builds the dashboard bundle, so
 * the tarball is what `npm publish` would upload), restore package.json. The stamp is
 * the point — an unstamped pack says the RELEASE version, so `memhouse --version` lies
 * on the test machine and `update --check` reports "already current".
 *
 * The tarball installs anywhere with `npm install -g <file>`. On such an install, use
 * `memhouse update --no-install` — plain update's npm step installs memhouse@latest,
 * which silently DOWNGRADES a nightly to the registry release.
 */
async function cmdNightly() {
  const { kind, root } = installKind();
  if (kind !== 'checkout') {
    console.log(bad(`nightly builds come from a checkout — this is a ${kind} install (${root})`));
    console.log('  git clone https://github.com/agent-realm/memhouse && cd memhouse && memhouse nightly');
    return 1;
  }
  // A dirty package.json cannot be restored by checkout without eating the user's edits.
  // npm version rewrites BOTH manifests; both must be clean and both are restored.
  const dirty = spawnSync('git', ['status', '--porcelain', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf-8' });
  if ((dirty.stdout || '').trim()) {
    console.log(bad('package.json / package-lock.json have uncommitted changes — commit or stash first;'));
    console.log('  the stamp/restore cycle would destroy them.');
    return 1;
  }
  const base = PKG.version.replace(/-.*$/, '');
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  // One ALPHANUMERIC identifier ('20260820T0103'), not two numeric ones. Semver forbids
  // leading zeros in numeric prerelease ids, so npm silently rewrote '.0103' to '.103'
  // — measured — and two nightlies from the same day sorted wrong. The 'T' keeps the
  // whole token alphanumeric, where leading zeros are legal and ordering is lexical.
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}T${p2(now.getHours())}${p2(now.getMinutes())}`;
  const version = `${base}-nightly.${stamp}`;
  const outDir = flags.out && flags.out !== true ? path.resolve(String(flags.out)) : root;

  console.log(`  building ${version} from ${root}`);
  try {
    let r = spawnSync('npm', ['version', version, '--no-git-tag-version'], { cwd: root, stdio: 'pipe' });
    if (r.status !== 0) { console.log(bad(`npm version failed: ${(r.stderr || '').toString().trim().split('\n')[0]}`)); return 1; }
    // prepack builds the ui — minutes, not seconds; inherit stdio so the wait is visible.
    r = spawnSync('npm', ['pack'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) { console.log(bad('npm pack failed — package.json is being restored')); return 1; }
    const file = (r.stdout || '').toString().trim().split('\n').pop();
    const src = path.join(root, file);
    const dst = path.join(outDir, file);
    if (src !== dst) { fs.mkdirSync(outDir, { recursive: true }); fs.renameSync(src, dst); }
    console.log(ok(`built ${dst}`));
    console.log('  install it:            npm install -g ' + dst);
    console.log('  on that machine, use:  memhouse update --no-install   (plain update would');
    console.log('  install memhouse@latest from the registry — a silent downgrade of a nightly)');
    return 0;
  } finally {
    // ALWAYS restore, whatever pack did — a checkout left claiming to be a nightly would
    // leak the stamp into the next real release. Both manifests: npm version touches the
    // lockfile too (measured; the first version of this restored only package.json).
    spawnSync('git', ['checkout', '--', 'package.json', 'package-lock.json'], { cwd: root, stdio: 'ignore' });
  }
}

/**
 * `memhouse invite <name> --url <house-url> --admin-user <a> --admin-password <p>
 *                  [--db <house>] [--out <file>]`
 *
 * Mint a member on the server and hand back the ONE FILE their install needs — this
 * machine's config is never touched and nothing local ships. The server half is exactly
 * adminBootstrap (create user if absent, create house, GRANT ALL + SELECT WITH GRANT
 * OPTION, async pin, then verify AS THE MEMBER), so an invited member is
 * indistinguishable from one minted by a local admin install — /mem:access works for
 * them on day one.
 *
 * The output file IS a credential. The header says so, the handoff advice names safe
 * transfer, and rotation (memhouse passwd) is printed because the inviter knows this
 * password until the invitee changes it.
 */
/**
 * `memhouse whoami [--json] [--admin]`
 *
 * Which credential is in play here, and what may it actually do. Exists so nothing has
 * to hand-roll `SHOW GRANTS` and grep the result — a skill that reasons about privileges
 * in prose gets it subtly wrong, and the wrong answer is either "you cannot" to an
 * administrator or "go ahead" to a member who is about to hit ACCESS_DENIED.
 *
 * `--admin` resolves MEMHOUSE_ADMIN_USER / MEMHOUSE_ADMIN_PASSWORD first, so an agent
 * can ask "is there an admin credential in this environment?" without inventing a place
 * to store one. Nothing here prints or persists a password.
 */
/**
 * `memhouse share <user> [--only <scope>] [--revoke]`, `memhouse share --list`
 *
 * Full share is a GRANT and nothing else. Partial share adds one ROW POLICY per room, so
 * the grantee reads only what the scope allows. See memhouse/share.js for why there is
 * deliberately no permissive catch-all policy, and what was measured to rule it out.
 */
async function cmdShare() {
  const share = require(path.join(REPO_ROOT, 'memhouse', 'share'));
  const cfg = requireConfig(resolveConfig(), 'share');
  if (!cfg.user) return 1;
  const db = cfg.db;
  // In a SHARED database a member owns three named rooms, not the database. Granting
  // `ON <db>.*` there would hand over every housemate's rooms as well — it fails closed
  // today (the member has no grant option on the database) but with a raw ACCESS_DENIED
  // naming a privilege nobody can explain. Grant the rooms this member actually owns.
  const mine = roomNames(cfg.user);
  // One grant on the member's own pattern: the shape the member holds, one level down
  // (SELECT only). It reaches nothing a housemate wrote.
  const shareTargets = [`${db}.${mine.pattern}`];

  // Statements, not reads: this is the one command in the read family that writes, so it
  // does NOT go through the readonly connection the skills use.
  const run = (sql) => ch(cfg, sql, { database: db });
  const rows = (sql) => chRows(cfg, sql, { database: db });

  // List only when asked for it, or when given nothing at all. `--only` or `--revoke`
  // without a user is a mistake worth naming, not a reason to print the list.
  const bare = !positional[0] && flags.only === undefined && flags.revoke === undefined;
  if (flags.list === true || bare) return shareList(cfg, share);

  const user = positional[0];
  if (!user) { console.log(bad('usage: memhouse share <user> [--only <scope>] [--revoke]  |  memhouse share --list')); return 2; }
  // The name is spliced into GRANT/REVOKE/CREATE POLICY unquoted, so it must be a name
  // ClickHouse accepts bare. Refuse rather than quote: a handle you cannot type plainly
  // is one that will be gotten wrong somewhere else.
  try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(user, 'user'); }
  catch (e) { console.log(bad(e.message)); return 1; }
  if (user === cfg.user) { console.log(bad(`'${user}' is you — you already read your own house`)); return 1; }

  // ── revoke ────────────────────────────────────────────────────────────────────
  // Dropping the grant alone leaves the policies behind, and they are NOT inert: a later
  // re-share silently inherits the old scope. Measured — a re-granted user saw 2,121 rows
  // instead of the whole house, with nothing on any surface explaining the filter.
  if (flags.revoke === true) {
    let dropped = 0;
    for (const room of ROOM_TYPES) {
      try { await run(`DROP ROW POLICY IF EXISTS ${share.policyName(user, room)} ON ${db}.${mine.physical[room]}`); dropped++; }
      catch (e) { console.log(warn(`could not drop the policy on ${room}: ${e.message.split('\n')[0]}`)); }
    }
    try { for (const tgt of shareTargets) await run(`REVOKE SELECT ON ${tgt} FROM ${user}`); }
    catch (e) { console.log(bad(`could not revoke: ${netReason(e)}`)); return 1; }
    await houseMeta(cfg, `share:${user}`, `revoked ${new Date().toISOString().slice(0, 10)}`);
    console.log(ok(`revoked '${user}' — SELECT withdrawn and ${dropped} row polic${dropped === 1 ? 'y' : 'ies'} dropped`));
    console.log('  Dropping the grant alone would have left the policies, and a later re-share');
    console.log('  would have quietly reinherited this scope.');
    return 0;
  }

  // ── grant ─────────────────────────────────────────────────────────────────────
  const scopeRaw = flags.only !== undefined && flags.only !== true ? String(flags.only) : null;
  let scope = null;
  if (flags.only === true) { console.log(bad('--only needs a scope, e.g. --only project=memhouse or --only session=<id>')); return 1; }
  if (scopeRaw) {
    try { scope = share.parseScope(scopeRaw); } catch (e) { console.log(bad(e.message)); return 1; }
  }

  // A partial share only behaves if readers WITHOUT a policy still see every row. That is
  // `users_without_row_policies_can_read_rows`, which is server config rather than a query
  // setting and whose default has moved between versions — so measure it, do not assume.
  if (scope) {
    const verdict = await probePermissive(cfg, db);
    if (verdict === false) {
      console.log(bad('this ClickHouse hides every row from readers that have no row policy.'));
      console.log('  Scoping one person would blindfold everyone else you have already shared with,');
      console.log('  and yourself. Nothing was changed. Ask whoever runs the server to set:');
      console.log('     <access_control_improvements>');
      console.log('       <users_without_row_policies_can_read_rows>true</users_without_row_policies_can_read_rows>');
      console.log('     </access_control_improvements>');
      console.log('  A full share (no --only) is unaffected and works today.');
      return 1;
    }
    if (verdict === null) console.log(warn('could not verify how this server treats readers without a policy — continuing'));
  }

  // A SCOPED share builds its filters BEFORE it grants anything. The order used to be the
  // other way round, and the failure mode was the worst one this command has: a member ran
  // `share <user> --only project=x`, the GRANT landed, the policy step was refused, and the
  // grantee was left able to read EVERY project — the exact opposite of what was asked for,
  // reported as "PARTIALLY APPLIED" after the fact. Building filters first means a refusal
  // leaves the grantee with exactly what they had before: nothing.
  if (scope) {
    const made = [];
    for (const room of ROOM_TYPES) {
      const pred = share.scopePredicate(scope, room, sqlStr);
      try {
        await run(`CREATE ROW POLICY OR REPLACE ${share.policyName(user, room)} ON ${db}.${mine.physical[room]} USING ${pred} TO ${user}`);
        made.push(room);
      } catch (e) {
        console.log(bad(`could not scope ${room}: ${e.message.split('\n')[0]}`));
        for (const r of made) {
          try { await run(`DROP ROW POLICY IF EXISTS ${share.policyName(user, r)} ON ${db}.${mine.physical[r]}`); } catch { /* best effort */ }
        }
        console.log(`  NOTHING WAS GRANTED — '${user}' can read no more than before, and any`);
        console.log('  filters this attempt created have been removed.');
        return 1;
      }
    }
  }

  try { for (const tgt of shareTargets) await run(`GRANT SELECT ON ${tgt} TO ${user}`); }
  catch (e) {
    console.log(bad(`could not grant: ${netReason(e)}`));
    // Filters without a grant are inert, but leaving them behind would make a later full
    // share silently scoped — the case the widening path below exists to catch.
    if (scope) {
      for (const room of ROOM_TYPES) {
        try { await run(`DROP ROW POLICY IF EXISTS ${share.policyName(user, room)} ON ${db}.${mine.physical[room]}`); } catch { /* best effort */ }
      }
    }
    return 1;
  }

  if (!scope) {
    // A previous partial share leaves policies that would still be filtering. Widening to
    // a full share has to clear them or "full" is a lie.
    let cleared = 0;
    for (const room of ROOM_TYPES) {
      try {
        const had = await rows(`SELECT count() AS n FROM system.row_policies WHERE database = ${sqlStr(db)} AND short_name = ${sqlStr(share.policyName(user, room))}`);
        if (Number(had[0] && had[0].n) > 0) { await run(`DROP ROW POLICY IF EXISTS ${share.policyName(user, room)} ON ${db}.${mine.physical[room]}`); cleared++; }
      } catch { /* nothing to clear */ }
    }
    await houseMeta(cfg, `share:${user}`, `granted ${new Date().toISOString().slice(0, 10)}`);
    console.log(ok(`'${user}' can now read every session in your rooms (${db}.${mine.pattern})`));
    if (cleared) console.log(warn(`cleared ${cleared} row polic${cleared === 1 ? 'y' : 'ies'} from an earlier scoped share — this is now a FULL share`));
    console.log(`  Everything: every project, machine and editor, including anything ever pasted`);
    console.log("  into a session of yours — housemates' rooms are untouched.");
    console.log(`  Narrow it with:  memhouse share ${user} --only project=<name>`);
    console.log(`  Withdraw with:                   memhouse share ${user} --revoke`);
    return 0;
  }

  // The filters are already in place — built above, before the grant.
  await houseMeta(cfg, `share:${user}`, `granted ${new Date().toISOString().slice(0, 10)} scope=${scopeRaw}`);

  // Say what they can actually reach, counted through their own filter.
  console.log(ok(`'${user}' can read your rooms in '${db}' where ${scopeRaw}`));
  for (const room of ROOM_TYPES) {
    try {
      const r = await rows(`SELECT count() AS n FROM ${room} WHERE ${share.scopePredicate(scope, room, sqlStr)}`);
      const all = await rows(`SELECT count() AS n FROM ${room}`);
      console.log(`  ${room.padEnd(11)} ${r[0].n} of ${all[0].n} rows`);
    } catch { /* counting is a courtesy */ }
  }
  console.log(`  Widen to everything:  memhouse share ${user}`);
  console.log(`  Withdraw:             memhouse share ${user} --revoke`);
  return 0;
}

/**
 * Does a reader with NO row policy still see rows once a policy exists on the table?
 *
 * Server config decides this and SQL cannot read it, so measure: put a deny-everything
 * policy on a scratch table aimed at everyone EXCEPT us, then read it. Rows back means
 * unpolicied readers are unaffected. Needs no second account and no admin.
 *
 * true = permissive, false = restrictive, null = could not tell.
 */
async function probePermissive(cfg, db) {
  const t = `_mh_probe_${process.pid}`;
  const run = (sql) => ch(cfg, sql, { database: db });
  try {
    await run(`CREATE TABLE IF NOT EXISTS ${t} (x UInt8) ENGINE = MergeTree ORDER BY x`);
    await run(`INSERT INTO ${t} VALUES (1)`, { settings: { async_insert: 0 } });
    await run(`CREATE ROW POLICY OR REPLACE ${t}_p ON ${db}.${t} USING 0 TO ALL EXCEPT ${cfg.user}`);
    const r = await chRows(cfg, `SELECT count() AS n FROM ${t}`, { database: db });
    return Number(r[0] && r[0].n) === 1;
  } catch { return null; } finally {
    try { await run(`DROP ROW POLICY IF EXISTS ${t}_p ON ${db}.${t}`); } catch { /* nothing staged */ }
    try { await run(`DROP TABLE IF EXISTS ${t} SYNC`); } catch { /* nothing staged */ }
  }
}

/** Who can read this house, what they are scoped to, and any policy left behind. */
async function shareList(cfg, share) {
  const db = cfg.db;
  let recorded = [];
  try {
    recorded = await chRows(cfg, `SELECT substring(key, 7) AS user, value AS state FROM ${physicalRoom('house_meta', cfg.user)} FINAL WHERE key LIKE 'share:%' ORDER BY key`, { database: db });
  } catch { /* unreadable record */ }
  let policies = [];
  try {
    policies = await chRows(cfg, `SELECT short_name, table, select_filter FROM system.row_policies WHERE database = ${sqlStr(db)} ORDER BY short_name`, { database: db });
  } catch { /* members may not read system.row_policies on every server */ }

  if (!recorded.length && !policies.length) {
    if (JSON_OUT) { console.log(JSON.stringify({ database: db, rooms: `${cfg.user}_*`, grantees: [] }, null, 2)); return 0; }
    console.log(ok(`nobody has been granted a read of your rooms in '${db}'`));
    console.log(`  Share it with:  memhouse share <user> [--only project=<name>]`);
    return 0;
  }
  // In a shared house a grantee reads YOUR ROOMS, never the database — every other member
  // keeps their own rooms in it and none of them were shared by this.
  if (JSON_OUT) {
    // The flag was accepted and ignored, so `share --list --json` printed the human text
    // and any caller parsing it got prose. It is the audit surface; it should be readable
    // by something other than a person.
    console.log(JSON.stringify({
      database: db, rooms: `${cfg.user}_*`,
      grantees: recorded.map((r) => ({
        user: r.user, state: r.state,
        scoped: policies.filter((p) => String(p.short_name).startsWith(`mh_share_${r.user}_`))
          .map((p) => ({ room: p.table, filter: p.select_filter })),
      })),
      note: "memhouse's own record, not ClickHouse's grant table — a grant made by hand does not appear here",
    }, null, 2));
    return 0;
  }
  console.log(`  who can read your rooms in '${db}' — memhouse's own record, not ClickHouse's grant table:`);
  for (const r of recorded) {
    const scoped = policies.filter((p) => String(p.short_name).startsWith(`mh_share_${r.user}_`));
    const whole = '  (all your rooms)';
    console.log(`    ${String(r.user).padEnd(16)} ${r.state}${scoped.length ? '' : (String(r.state).startsWith('granted') ? whole : '')}`);
    for (const p of scoped) console.log(`      ${String(p.table).padEnd(11)} ${p.select_filter}`);
  }
  console.log('  A grant made by hand does not appear here — this list is what memhouse recorded.');

  // Policies whose room is gone: dropping a house does NOT drop its policies, and a house
  // later recreated under the same name silently inherits them.
  const orphans = [];
  for (const p of policies) {
    try {
      const e = await chRows(cfg, `SELECT count() AS n FROM system.tables WHERE database = ${sqlStr(db)} AND name = ${sqlStr(p.table)}`, { database: db });
      if (Number(e[0] && e[0].n) === 0) orphans.push(p);
    } catch { /* cannot tell */ }
  }
  if (orphans.length) {
    console.log('');
    console.log(warn(`${orphans.length} row polic${orphans.length === 1 ? 'y points' : 'ies point'} at a table that no longer exists:`));
    for (const p of orphans) console.log(`    ${p.short_name} ON ${db}.${p.table}`);
    console.log('  Dropping a table or a house leaves its policies behind, and recreating one under');
    console.log('  the same name silently reinherits them. Drop them:');
    for (const p of orphans) console.log(`     DROP ROW POLICY ${p.short_name} ON ${db}.${p.table}`);
  }
  return 0;
}

async function cmdWhoami() {
  const cfg = resolveConfig();
  const wantAdmin = flags.admin === true;
  const au = cfg.adminUser || undefined;
  const ap = cfg.adminPassword || undefined;
  const usingAdminEnv = wantAdmin && au;
  // `--admin` with nothing to resolve is worth saying out loud. Silently falling back to
  // the member credential makes `whoami --admin` and `whoami` print the same thing, and
  // the reader is left thinking they asked a question the program never heard.
  const who = usingAdminEnv ? { ...cfg, user: au, password: ap || '' } : cfg;

  if (!who.url || !who.user) {
    const msg = 'no credential configured';
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, reason: msg }, null, 2));
    else {
      console.log(bad(`${msg} — nothing in ${short(ENV_FILE)} and no MEMHOUSE_URL/MEMHOUSE_USER set.`));
      if (wantAdmin) console.log('  For --admin, export MEMHOUSE_ADMIN_USER and MEMHOUSE_ADMIN_PASSWORD.');
    }
    return 1;
  }

  let server = null;
  try { server = (await chRows(who, 'SELECT currentUser() AS u', { database: '' }))[0]?.u; }
  catch (e) {
    const reason = netReason(e);
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, url: who.url, user: who.user, reason }, null, 2));
    else console.log(bad(`cannot reach ${who.url} as '${who.user}': ${reason}`));
    return 1;
  }

  const grants = await readGrants(who, server);
  const caps = capabilitiesFrom(grants);
  const source = usingAdminEnv ? 'MEMHOUSE_ADMIN_* environment'
    : (process.env.MEMHOUSE_USER ? 'MEMHOUSE_* environment' : short(ENV_FILE));
  const role = caps.isSuperuser ? 'administrator'
    : caps.canProvision ? 'can provision (users and houses)'
      : 'member';

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: true, url: who.url, user: server, db: who.db, source, role, ...caps,
      grants_readable: grants.length > 0,
      admin_env_present: Boolean(au),
      admin_requested: wantAdmin,
    }, null, 2));
    return 0;
  }
  console.log(ok(`${server} at ${who.url} — ${role}`));
  if (wantAdmin && !usingAdminEnv) {
    console.log(warn('--admin asked for MEMHOUSE_ADMIN_USER / MEMHOUSE_ADMIN_PASSWORD; neither is set,'));
    console.log('  so this is the ordinary configured credential.');
  }
  console.log(`  credential from: ${source}`);
  console.log(`  house:           ${who.db || '(none set)'}`);
  console.log(`  may create users:    ${caps.canMintUsers ? 'yes' : 'no'}`);
  console.log(`  may create houses:   ${caps.canMintHouses ? 'yes' : 'no'}`);
  console.log(`  may read any house:  ${caps.canReadEveryHouse ? 'yes' : 'no'}`);
  if (!grants.length) console.log(warn('could not read its own grants — treating it as a member'));
  if (!caps.canProvision) {
    console.log('  Inviting and server-wide administration need an administrator; this is not one.');
    console.log('  Supply one for this shell:  export MEMHOUSE_ADMIN_USER=… MEMHOUSE_ADMIN_PASSWORD=…');
  }
  return 0;
}

async function cmdInvite() {
  const name = positional[0];
  if (!name) { console.log('usage: memhouse invite <name> --url <house-url> [--admin-user … [--admin-password …]] [--db <house>] [--out <file>] [--adopt] [--print-sql]'); return 2; }
  try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(name, 'member'); }
  catch (e) { console.log(bad(e.message)); return 1; }
  const cfg = resolveConfig();
  // The URL must be STATED and must work from the INVITEE's machine. cfg.url falls back
  // to localhost:8123 — dead, or worse, someone else's house, on every other machine.
  const url = flags.url && flags.url !== true ? String(flags.url) : null;
  if (!url) { console.log(bad('an invite needs --url — the address the INVITEE will reach the house at')); return 1; }
  let host = null;
  try { host = new URL(url).hostname; } catch { console.log(bad(`--url is not a URL: ${url}`)); return 1; }
  const hnorm = host.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = hnorm === 'localhost' || hnorm === '::1' || hnorm === '0.0.0.0'
    || /^127\./.test(hnorm) || /^127(\.\d+){0,2}$/.test(hnorm); // 127.x, and short forms like 127.1
  if (isLoopback && flags['allow-local'] !== true) {
    console.log(bad(`${url} is loopback (${host}) — it points at the INVITEE's machine, not this house.`));
    console.log('  Use an address they can reach (LAN IP, hostname, tunnel). --allow-local overrides');
    console.log('  for the same-machine case.');
    return 1;
  }
  // ONE layout: the member's rooms are named for them inside whichever house --db names,
  // and the default is the configured house. There is nothing else to choose.
  // Default to the configured house only when inviting into the SAME server this install
  // ships to; a different --url is a different house, and its default is `mem`. Without
  // this, an invite to a fresh server named its database after whatever this machine's env
  // file happened to hold.
  // resolveConfig() lets --url win, so cfg.url IS the flag here; the CONFIGURED house is
  // what the env file or environment says, and that is what "same server" means.
  const configuredUrl = process.env.MEMHOUSE_URL || readEnvFile().MEMHOUSE_URL || null;
  const db = flags.db && flags.db !== true ? String(flags.db)
    : (configuredUrl && sameEndpoint(configuredUrl, url) ? cfg.db : 'mem');
  try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(db, 'house'); }
  catch (e) { console.log(bad(e.message)); return 1; }

  // The way out for someone who is NOT the administrator. Being unable to invite is not a
  // bug to be worked around — a member holds no CREATE USER by design — but "ask your
  // admin" is only useful if you can hand them something exact. This prints the same
  // statements adminBootstrap would run, so the person with the credential runs four
  // lines instead of installing anything. Nothing is contacted and nothing is written.
  if (flags['print-sql'] === true) {
    const password = flags['member-password'] && flags['member-password'] !== true
      ? String(flags['member-password']) : generatePassword();
    // memberSql prints its own header naming the house and the credential it needs; a
    // second one above it said the same thing twice, and in a shared house said the wrong
    // thing ("their own house" — they get rooms in a shared one).
    console.log(memberSql(db, name, password));
    console.log('-- Then send them these four lines — they are a credential, so use a channel');
    console.log('-- you trust (croc, a password manager), not chat:');
    console.log(`--   MEMHOUSE_URL='${url}'`);
    console.log(`--   MEMHOUSE_USER='${name}'`);
    console.log(`--   MEMHOUSE_PASSWORD='${password}'`);
    console.log(`--   MEMHOUSE_DB='${db}'`);
    console.log(`-- They install with:  memhouse install --url ${url} --user ${name} --password '…' --db ${db}`);
    return 0;
  }

  // Whose credential mints the member. Explicit --admin-* wins; otherwise TRY THE
  // CONFIGURED ONE — a `deploy --local` house makes its member the superuser
  // (CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1), so the person who stood the house up
  // invites with no extra flags.
  // --admin-* wins. Otherwise the admin credential this install keeps beside its member
  // credential (a house you deployed or administer). Failing both, the member credential
  // itself is tried below — which works for whoever set the house up as its superuser.
  let adminUser = flags['admin-user'] || cfg.adminUser || undefined;
  let adminPass = flags['admin-password'] || (!flags['admin-user'] && cfg.adminPassword) || undefined;
  if (!adminUser) {
    const c = requireConfig(cfg, 'invite');
    if (!c.user) return 1;
    // Ask what this credential may actually DO, not whether it can look at a table.
    // The old probe was `SELECT 1 FROM system.users` — but since 0.12.6 every member is
    // granted SHOW USERS, so every member passed it, was told "it can manage users on
    // this house", and then died at CREATE DATABASE with a raw ACCESS_DENIED. A probe
    // that says yes to everyone is worse than no probe: it turns "you are not an admin"
    // into a confusing failure three steps later.
    //
    // chRows appends FORMAT itself, so DO NOT pass one — a statement carrying FORMAT
    // twice is a syntax error, which the catch below turned into "no grants" and refused
    // EVERY credential, a real superuser included. Only a clean machine could show that:
    // this machine's credential is a member either way, so the bug was invisible here.
    // Reachability FIRST, and reported as itself. Folding it into the grants read makes an
    // unreachable host — a typo, a loopback-bound house, a tunnel that is down — come back
    // as "you are only a member", which sends the reader after a privilege they already
    // have. Caught on the testbed, where a wrong --url produced exactly that.
    try {
      await ch({ ...c, url }, 'SELECT 1', { database: '' });
    } catch (e) {
      console.log(bad(`cannot reach ${url} as '${c.user}': ${netReason(e)}`));
      console.log('  --url is the address the INVITEE will use, and invite checks it from here first.');
      console.log('  A `deploy --local` house is bound to loopback on purpose, so no LAN address');
      console.log('  reaches it and no invitee could either — publish it (tunnel, reverse proxy)');
      console.log('  before inviting, or use --print-sql and let the invitee be told the address.');
      return 1;
    }
    // What this credential may do, judged from its own grants and SCOPE-AWARE — a member
    // holds CREATE DATABASE inside `ON <their-db>.*`, which mints no new house at all.
    // Shared with `whoami` so the two can never disagree about who is an administrator.
    const caps = capabilitiesFrom(await readGrants({ ...c, url }, c.user));
    if (caps.canProvision) {
      adminUser = c.user; adminPass = c.password;
      console.log(ok(`inviting as your own credential '${c.user}' (it can create users and houses here)`));
    } else {
      console.log(bad(`'${c.user}' is a MEMBER of this ClickHouse, not an administrator — it cannot create accounts.`));
      console.log('  Inviting mints a ClickHouse user and a database, which needs CREATE USER and');
      console.log('  CREATE DATABASE. A member deliberately holds neither: that is the boundary that');
      console.log('  keeps one housemate out of another house.');
      console.log('');
      console.log('  If you RUN this ClickHouse — use the admin credential you created it with');
      console.log('  (for a stock server that is `default`); memhouse never stores it, so pass it');
      console.log('  per invite and it is used for one connection and discarded:');
      console.log(`     memhouse invite ${name} --url ${url} --admin-user default`);
      console.log('     (leave --admin-password off and it is prompted for, so it stays out of');
      console.log('      your shell history and the process list)');
      console.log('');
      console.log('  If SOMEONE ELSE runs it — you cannot invite, and no flag changes that.');
      console.log('  Print the statements and send them to whoever administers the server:');
      console.log(`     memhouse invite ${name} --url ${url} --print-sql`);
      return 1;
    }
  } else if (adminPass === undefined) {
    // Prompt rather than refuse. A password given as --admin-password lands in the
    // process list for the life of the request and in shell history unless the caller
    // remembered a leading space; asking for it keeps it in this process only.
    // Non-TTY (an agent, CI) still gets the old refusal — there is nobody to ask.
    if (!process.stdin.isTTY) {
      console.log(bad('--admin-user given without --admin-password (no TTY to prompt on)'));
      return 1;
    }
    adminPass = await askSecret(`  password for '${adminUser}'`);
    if (!adminPass) { console.log(bad('no password given')); return 1; }
  }

  // WHERE to connect to provision. --url is the address the INVITEE will use — it may be
  // a LAN IP or tunnel that is not this admin's own endpoint, and sending the stored
  // credential there would hand it to whatever answers a typo'd or hostile --url. So the
  // stored-credential path provisions at the admin's OWN configured cfg.url; only an
  // EXPLICIT --admin-* (where the admin typed the target themselves) provisions at --url.
  // Either way the invite FILE carries --url, the invitee's path.
  const provisionUrl = flags['admin-user'] ? url : cfg.url;

  // Is there already a house here, with somebody's memory in it? The house is created
  // with CREATE DATABASE IF NOT EXISTS, so inviting a name whose database already exists
  // ADOPTS it — same output as a fresh one, and the invitee lands on top of rows that are
  // not theirs. (The user half is safe: adminBootstrap refuses an existing ClickHouse
  // user, so no sitting member's password is ever rotated out from under them.)
  //
  // Found the hard way: an invite meant for one person was sent to another, who shipped
  // 3,733 messages under it. Re-inviting the intended person reported success and handed
  // them the first person's memory, with nothing on any surface saying so.
  //
  // Read-only, best-effort: an admin that cannot count rows should not lose the ability
  // to invite, and a house that does not exist yet is the ordinary case.
  const adminCfg = { ...cfg, url: provisionUrl, user: adminUser, password: adminPass || '', db, stated: true };

  const room = physicalRoom('messages', name);
  let occupied = null;
  try {
    const exists = await chRows(adminCfg, `SELECT count() AS n FROM system.tables WHERE database = '${db.replace(/'/g, "\\'")}' AND name = '${room.replace(/'/g, "\\'")}'`, { database: '' });
    if (Number(exists[0] && exists[0].n) > 0) {
      const r = await chRows(adminCfg, `SELECT count() AS msgs, uniqExact(user_id) AS writers FROM ${room}`, { database: db });
      const msgs = Number(r[0] && r[0].msgs) || 0;
      if (msgs > 0) occupied = { msgs, writers: Number(r[0].writers) || 0 };
    }
  } catch { /* cannot tell — provisioning below will surface any real access problem */ }
  if (occupied && flags.adopt !== true) {
    console.log(bad(`${db}.${room} already exists and holds ${occupied.msgs} messages from ${occupied.writers} writer(s) — NOT inviting.`));
    console.log(`  Inviting '${name}' here would hand them somebody else's memory, and their`);
    console.log('  first ship would land on top of it. Nothing has been changed.');
    console.log('  Pick a different handle:   memhouse invite <other-name> --url …');
    console.log(`  Or a different house:      memhouse invite ${name} --url … --db <house>`);
    console.log(`  Taking the house over — same person, new credential:  --adopt`);
    return 1;
  }
  if (occupied) {
    console.log(warn(`adopting existing house '${db}' — ${occupied.msgs} messages already here (--adopt)`));
    console.log(`  '${name}' will read and ship on top of them. If that memory belongs to`);
    console.log('  somebody else, stop now — this is a takeover, not a shared house.');
  }

  const built = await adminBootstrap({ ...cfg, url: provisionUrl, db, stated: true }, {
    user: adminUser, password: adminPass || '', member: name, quiet: true,
  });
  if (built) built.url = url; // the invitee reaches the house at --url, not the admin's endpoint
  if (!built) return 1;

  const out = path.resolve(flags.out && flags.out !== true ? String(flags.out) : `invite-${name}.env`);
  const sq = envfile.quoteShell;
  const body = [
    `# memhouse invite for '${name}' — THIS FILE IS A CREDENTIAL. Treat it like a password:`,
    '# hand it over a channel you trust, and delete it after install.',
    '# The person who created it knows the password inside — so when you install, memhouse',
    '# OFFERS to change it to one only you know (you were granted ALTER USER on yourself).',
    `# Install: memhouse install --env ${path.basename(out)}`,
    `MEMHOUSE_URL=${sq(built.url)}`,
    `MEMHOUSE_USER=${sq(built.user)}`,
    `MEMHOUSE_PASSWORD=${sq(built.password)}`,
    `MEMHOUSE_DB=${sq(built.db)}`,
    '# This credential was issued by an invitation (no admin access here); memhouse offers',
    '# to rotate it on install so the inviter no longer knows it.',
    'MEMHOUSE_INVITE=1',
    '',
  ].join('\n');
  // Atomic + private + no symlink follow: write a fresh temp with O_EXCL at 0600, then
  // rename over the target. writeFileSync's mode is IGNORED when the file already exists,
  // so a stale 0644 invite would otherwise receive the new password world-readable, and a
  // symlink at the path would be followed. rename also means no half-written file is ever
  // readable as an invite.
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, body); fs.closeSync(fd);
    fs.renameSync(tmp, out);
    fs.chmodSync(out, 0o600);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    console.log(bad(`the member was provisioned, but the invite file could not be written: ${e.message}`));
    console.log(`  re-run with a writable --out, then rotate: the account exists as '${name}'.`);
    return 1;
  }
  console.log(ok(`invite written: ${out}`));
  console.log(`  hand it to ${name} over a channel you trust (croc, a password manager — not chat).`);
  console.log(`  they run:   memhouse install --env ${path.basename(out)}`);
  console.log(`  then they should rotate the password you now both know:  memhouse passwd`);
  console.log(`  once installed, they are a member — sharing works both ways: /mem:access ${name}`);
  return 0;
}

/**
 * `memhouse passwd [--password <new>] --admin-user <a> --admin-password <p>`
 *
 * Rotate THIS install's member password and rewrite the env file. Admin-assisted by
 * ClickHouse's rules — changing any password takes the ALTER USER privilege, which a
 * member deliberately does not hold (holding it would let them alter EVERY user). The
 * use case that makes rotation matter: an invited member's password was generated on
 * the INVITER's machine, and stays known there until changed here.
 */
async function cmdPasswd({ quiet = false, forNext = null } = {}) {
  const cfg = requireConfig(resolveConfig(), 'passwd');
  try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(cfg.user, 'user'); }
  catch (e) { console.log(bad(e.message)); return 1; }
  const next = forNext || (flags.password && flags.password !== true ? String(flags.password) : generatePassword());
  const escPw = next.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // SELF-ROTATION FIRST. Since 0.11 a member holds `ALTER USER ON <self>`, so changing
  // their own password needs no admin. Try it as the member; fall back to an admin
  // credential only for a pre-0.11 member (or a house minted without access management),
  // and only if one was supplied.
  const adminUser = flags['admin-user'];
  try {
    await ch(cfg, `ALTER USER \`${cfg.user}\` IDENTIFIED BY '${escPw}'`, { database: '' });
  } catch (selfErr) {
    const m = selfErr && selfErr.message ? selfErr.message : String(selfErr);
    // ONLY a privilege refusal means "cannot self-rotate, try admin". A transport error
    // (timeout, connection reset) must be REPORTED, not silently relabelled as a pre-0.11
    // member — and it must not be reconciled as a lost-response success below, because the
    // ALTER may never have reached the server.
    if (!/Not enough privileges|ACCESS_DENIED/i.test(m)) {
      // The ALTER may have COMMITTED and only the response was lost — check before giving
      // up, or a random new password vanishes and the member is locked out. If the OLD
      // credential no longer works, the change took: persist the new one we still hold.
      try {
        await ch(cfg, 'SELECT 1', { database: '' });
        console.log(bad(`could not rotate: ${m.split('\n')[0]}`));
        console.log('  the old password still works and nothing was changed — retry.');
        return 1;
      } catch {
        try {
          await ch({ ...cfg, password: next }, 'SELECT 1', { database: '' });
          console.log(warn('the rotation response was lost, but the new password is live — saving it.'));
          writeEnvFile({ ...cfg, password: next });
          if (!quiet) console.log(ok(`password rotated for '${cfg.user}'`));
          return 0;
        } catch {
          console.log(bad(`rotation is in an unknown state: ${m.split('\n')[0]}`));
          console.log('  neither the old nor a new password authenticates — recover as admin (ALTER USER … IDENTIFIED BY …).');
          return 1;
        }
      }
    }
    if (!adminUser || flags['admin-password'] === undefined) {
      console.log(bad(`'${cfg.user}' cannot change its own password on this house (pre-0.11 member, or no access management).`));
      console.log('  Rotate with an admin credential:  memhouse passwd --admin-user <a> --admin-password <p>');
      return 1;
    }
    const via = { ...cfg, user: adminUser, password: flags['admin-password'] || '' };
    try { await ch(via, `ALTER USER \`${cfg.user}\` IDENTIFIED BY '${escPw}'`, { database: '' }); }
    catch (e) { console.log(bad(`could not rotate: ${e.message}`)); return 1; }
  }
  // Prove the new credential BEFORE persisting it — a password changed on the server but
  // unverified here would strand the very install it was meant to protect.
  try { await ch({ ...cfg, password: next }, 'SELECT 1', { database: '' }); }
  catch (e) {
    console.log(bad(`the new password did not authenticate: ${e.message}`));
    console.log('  the env file was NOT touched; the server may now disagree with it — fix as admin.');
    return 1;
  }
  writeEnvFile({ ...cfg, password: next });
  if (quiet) { console.log(ok(`password rotated — this credential is now yours alone`)); return 0; }
  console.log(ok(`password rotated for '${cfg.user}' and ${ENV_FILE.replace(os.homedir(), '~')} updated`));
  console.log('  restart anything that inlines the credential here:  memhouse update --no-install');
  console.log(warn('this rotated the ONE server credential — every OTHER machine you ship as'));
  console.log(`  '${cfg.user}' now fails auth until it gets the new password (memhouse setup --password …).`);
  return 0;
}

async function cmdUninstall() {
  // Confirm FIRST, before the first destructive act. This used to start removing the
  // service the moment it was typed — and "uninstall" is exactly the kind of command a
  // person types to see what it would do. Name what THIS tier removes and keeps, ask
  // once; --yes answers it for scripts, and a non-interactive run WITHOUT --yes refuses
  // rather than proceeding — a destructive default in a pipeline should be spelled out.
  if (flags.yes !== true) {
    const fullT = flags['full-removal'] === true;
    const credsT = fullT || flags.credentials === true;
    const removes = ['the shipper/dashboard daemons and the OS service'];
    if (credsT) removes.push(`the house connection and its credential (${ENV_FILE.replace(os.homedir(), '~')})`);
    if (fullT) removes.push("this machine's host identity (a reinstall becomes a NEW host)");
    const keeps = [];
    if (!credsT) keeps.push('the house connection and credential');
    if (!fullT) keeps.push("this machine's host identity");
    keeps.push('ALL data in ClickHouse (no tier ever touches the house)');
    console.log('This removes:');
    for (const r of removes) console.log(`  - ${r}`);
    console.log('Kept:');
    for (const k of keeps) console.log(`  - ${k}`);
    if (!process.stdin.isTTY) {
      console.log(bad('not confirming a destructive command without a terminal — pass --yes to proceed'));
      process.exitCode = 1;
      return;
    }
    const a = (await ask('Uninstall? (yes/no)', 'no')).toLowerCase();
    if (a !== 'yes' && a !== 'y') { console.log('aborted'); return; }
  }

  // The OS service first, and this is not tidiness: it outlives the pidfile daemons by
  // design, it holds the credential inlined in its unit file, and it restarts itself. An
  // uninstall that stopped only the daemons would report success while a service kept
  // shipping transcripts — with a credential in a file the user now believes is gone.
  const svc = require(path.join(REPO_ROOT, 'memhouse', 'service.js'));
  const st = svc.status();
  if (st.kind && st.installed) {
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

  // Three tiers, and the default is the conservative one.
  //
  // This used to delete MEMHOUSE_HOME outright, which made "stop the daemons" and "forget
  // the house I connect to, and who this machine is" the same command. They are not the
  // same intent. Stopping the shipper is routine — before an upgrade, while debugging,
  // when a laptop should go quiet for a week. Discarding the credential is a decision, and
  // dropping the host fingerprint silently re-labels every row this machine ships after.
  //
  //   (default)         daemons, service, runtime state. Config and identity KEPT.
  //   --credentials     also forget the house: the env file, with its password.
  //   --full-removal    all of MEMHOUSE_HOME, fingerprint included. The next install is a
  //                     NEW host whose rows do not join this machine's history.
  //
  // No tier touches the house: transcripts live in ClickHouse and re-ship from the local
  // session stores regardless.
  const hostjs = require(path.join(REPO_ROOT, 'memhouse', 'host.js'));
  const full = flags['full-removal'] === true;
  const creds = full || flags.credentials === true;
  const hostFile = hostjs.filePath(HOME_DIR);

  if (!fs.existsSync(HOME_DIR)) {
    console.log(ok('daemons stopped — no state directory to remove'));
    return;
  }

  if (full) {
    // The only tier that discards the machine's identity, so the only one that asks.
    // Re-installing afterwards starts a second host inside the same rooms, and nothing
    // later can stitch the two halves together.
    if (flags.yes !== true && process.stdin.isTTY) {
      const id = hostjs.read(HOME_DIR);
      console.log(warn(`--full-removal also discards this machine's host identity${id ? ` (${id.id})` : ''}.`));
      console.log('  Rows already shipped keep that name, a future install gets a new one, and');
      console.log("  this machine then reads as two. Your transcripts themselves are safe.");
      const a = (await ask('Remove everything, including the host identity? (yes/no)', 'no')).toLowerCase();
      if (a !== 'yes' && a !== 'y') { console.log('aborted — daemons are stopped, nothing was removed'); return; }
    }
    fs.rmSync(HOME_DIR, { recursive: true });
    console.log(ok(`removed ${short(HOME_DIR)} entirely — config, credential and host identity`));
    console.log('  the house data in ClickHouse is untouched');
    return;
  }

  // Runtime state only: pidfiles and logs. The next `start` rebuilds both, and neither is
  // worth keeping once nothing is running.
  for (const d of ['run', 'logs']) {
    const p = path.join(HOME_DIR, d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
  }
  console.log(ok('removed runtime state (pidfiles, logs)'));

  if (creds) {
    if (fs.existsSync(ENV_FILE)) {
      fs.rmSync(ENV_FILE);
      console.log(ok(`removed ${short(ENV_FILE)} — the house connection and its credential`));
    } else {
      console.log(warn('no config file to remove'));
    }
  } else if (fs.existsSync(ENV_FILE)) {
    console.log(ok(`kept ${short(ENV_FILE)} — the house connection and its credential`));
    console.log('  forget it too with: memhouse uninstall --credentials');
  }

  if (fs.existsSync(hostFile)) {
    console.log(ok(`kept ${short(hostFile)} — this machine's identity, so a reinstall continues its history`));
    console.log('  remove everything with: memhouse uninstall --full-removal');
  }
  console.log('  the house data in ClickHouse is untouched');
}

// ── dispatch ────────────────────────────────────────────────────────────────────
(async () => {
  // Single-dash flags are not parsed (only `--x`), so `-v` arrives as a positional. Both
  // spellings are what people type for a version.
  if (flags.version === true || process.argv.slice(2).some((a) => a === '-v' || a === '-V')) {
    console.log(PKG.version); return;
  }
  // `memhouse <cmd> --help` (or `-h`) must never reach a command's own logic — passwd,
  // invite, uninstall and friends act on first call with no separate confirm step, so a
  // --help that fell through to the default branch would DO the thing instead of
  // describing it. One check ahead of the switch, for every command, is the whole fix.
  if (cmd && (flags.help === true || process.argv.slice(2).some((a) => a === '-h' || a === '--help'))) {
    console.log(HELP); return;
  }
  const cfg = resolveConfig();

  switch (cmd) {
    case null: case 'help': console.log(HELP); break;
    // `--version` and `-v` land here as flags, not as the `version` verb, so they used to
    // fall through to HELP: forty lines of help and exit 0 is not what --version means.
    case 'version': console.log(PKG.version); break;
    case 'discover': await cmdDiscover(); break;
    case 'onboard': process.exitCode = await cmdOnboard(); break;
    case 'install': process.exitCode = await cmdInstall({ interactive: false }); break;
    case 'setup': {
      // Dual-mode like install: --yes (with any --url/--user/--password/--db/
      // --port overrides, already resolved into cfg) skips every prompt so
      // agents/CI can rewrite the config non-interactively.
      const c = { ...cfg };
      // `install` refuses to guess http://localhost:8123 as memhouse_root, with a comment
      // explaining why; `setup --yes` wrote precisely that config in one command, exit 0,
      // and five Enters through the interactive form did the same. A guard at one command
      // is not a guard.
      if (!cfg.stated && flags.yes === true) {
        console.log(bad('no house given: --url and --user are required with --yes'));
        console.log('  setup will not write http://localhost:8123 as memhouse_root into your config.');
        // 2, like every other no-config refusal. A script gating on the exit code got a
        // different answer from these two commands than from the other eight.
        process.exitCode = 2;
        break;
      }
      if (flags.yes !== true) {
        c.url = await ask('  ClickHouse URL', cfg.stated ? c.url : '');
        c.user = await ask('  user', cfg.stated ? c.user : '');
        if (!c.url || !c.user) {
          console.log(bad('a URL and a user are required — memhouse will not pick a house for you'));
          process.exitCode = 1;
          break;
        }
        c.password = await askSecret('  password', c.password);
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
      requireConfig(cfg, 'ship');
      const args = [];
      // --ensure-schema was accepted by the parser and never forwarded, so asking for a
      // schema-only rollout shipped 398 sessions instead and exited 0.
      if (flags['ensure-schema'] === true) args.push('--ensure-schema');
      if (flags.full === true) args.push('--full');
      if (flags.loop !== undefined) { args.push('--loop'); if (flags.loop !== true) args.push(String(flags.loop)); }
      process.exitCode = run(SHIP_JS, args, cfg);
      break;
    }
    case 'stats': requireConfig(cfg, 'stats'); process.exitCode = run(SHIP_JS, ['--stats'], cfg); break;
    case 'start': await cmdStart(); break;
    case 'stop': cmdStop(); break;
    case 'status': process.exitCode = await cmdStatus(); break;
    case 'doctor': process.exitCode = await cmdDoctor(); break;
    case 'search': process.exitCode = await cmdSearch(); break;
    case 'resume': process.exitCode = await cmdResume(); break;
    case 'update': process.exitCode = await cmdUpdate(); break;
    // The session rollup is a saved query, not an object, so there is no name an agent
    // or a skill can put in a FROM clause. This prints it, resolved for whoever the
    // configured credential is — the substitute for that name.
    case 'sessions-query': {
      const cfg = requireConfig(resolveConfig(), 'sessions-query');
      const r = await roomsFor(cfg);
      // On STDOUT and inside the SQL. This used to go to stderr, so `sessions-query >
      // q.sql` kept the query and dropped the instruction it depended on. The rollup now
      // carries FINAL and join_use_nulls itself, so the note is provenance, not a warning.
      if (!JSON_OUT) console.log(`-- memhouse rollup for '${r.member}' — self-contained (FINAL + join_use_nulls).`);
      console.log(r.sessions_v);
      break;
    }
    case 'members': {
      // "Who is in this database, and what can each of them reach?" Before shared houses a
      // database had exactly one member and the question did not exist; this layout creates
      // it, and an operator had no supported way to answer — they had to hand-write SQL
      // against system.grants. Found in a drill.
      const cfg = requireConfig(resolveConfig(), 'members');
      const db = flags.db && flags.db !== true ? String(flags.db) : cfg.db;
      // --admin-* wins; otherwise the admin credential this install keeps (a house you
      // deployed or administer). A member alone cannot read other accounts' grants.
      const au = flags['admin-user'] && flags['admin-user'] !== true ? String(flags['admin-user']) : (cfg.adminUser || null);
      const ap = flags['admin-password'] && flags['admin-password'] !== true ? String(flags['admin-password']) : (cfg.adminPassword || '');
      // Reading ANOTHER account's grants needs privilege; without it ClickHouse simply
      // returns fewer rows. Say so rather than presenting a short list as the whole truth.
      const who = au ? { ...cfg, user: au, password: ap } : cfg;
      let rows = [];
      try {
        // `is_wildcard` arrived in 26.x. On 25.11 — the default local tag — a wildcard grant
        // is enforced identically but its row carries only the bare prefix (`alice_`), so
        // without the column the trailing underscore is the marker.
        const hasWild = Number((await chRows(who, "SELECT count() AS n FROM system.columns WHERE database = 'system' AND table = 'grants' AND name = 'is_wildcard'", { database: '' }))[0]?.n) > 0;
        const star = hasWild ? "if(is_wildcard, '*', '')" : "if(endsWith(table, '_'), '*', '')";
        rows = await chRows(who,
          `SELECT user_name AS u, max(table IS NULL) AS db_wide,
                  arrayStringConcat(arraySort(groupUniqArray(concat(table, ${star}))), ', ') AS tables
             FROM system.grants
            WHERE database = ${sqlStr(db)} AND user_name IS NOT NULL
            GROUP BY user_name ORDER BY user_name`, { database: '' });
      } catch (e) {
        console.log(bad(`could not read the grant table: ${e.message}`));
        console.log('  Pass an admin credential:  memhouse members --admin-user <a> --admin-password <p>');
        process.exitCode = 1; break;
      }
      if (JSON_OUT) {
        console.log(JSON.stringify({ database: db, members: rows.map((r) => ({
          name: r.u, scope: Number(r.db_wide) === 1 ? 'database' : 'rooms',
          rooms: Number(r.db_wide) === 1 ? null : String(r.tables || '').split(', ').filter(Boolean),
        })) }, null, 2));
        break;
      }
      if (!rows.length) {
        console.log(ok(`no member holds a grant on '${db}'`));
        console.log(`  Either it is empty, or this credential cannot see other accounts' grants.`);
        console.log('  With an admin:  memhouse members --db ' + db + ' --admin-user <a> --admin-password <p>');
        break;
      }
      const owners = rows.filter((r) => Number(r.db_wide) === 1);
      console.log(`  '${db}' — ${rows.length} member(s):`);
      for (const r of rows) {
        if (Number(r.db_wide) === 1) console.log(`    ${String(r.u).padEnd(16)} the whole database`);
        else console.log(`    ${String(r.u).padEnd(16)} ${String(r.tables || '(none)')}`);
      }
      if (owners.length && rows.length > 1) {
        console.log('');
        console.log(warn(`'${owners[0].u}' holds the WHOLE database while others hold rooms in it —`));
        console.log(`  they can read and re-grant every housemate's rows. memhouse does not create`);
        console.log(`  this shape; something granted it by hand. Narrow it to their own rooms.`);
      }
      if (!au) console.log('  (run with --admin-user to be sure you are seeing every account)');
      break;
    }
    case 'rooms': {
      // What are my rooms called? One answer, in one place: named for the member, inside the
      // configured house. It resolves through roomNames(), so it cannot drift from what the
      // shipper writes to.
      const cfg = requireConfig(resolveConfig(), 'rooms');
      const r = await roomsFor(cfg);
      const names = {};
      for (const t of [...ROOM_TYPES, ...META_TYPES]) names[t] = r.physical[t];
      if (JSON_OUT) {
        console.log(JSON.stringify({ database: cfg.db, member: r.member, pattern: r.pattern, rooms: names }, null, 2));
      } else {
        console.log(`${cfg.db} — your rooms, named for you (${cfg.db}.${r.pattern}):`);
        for (const t of [...ROOM_TYPES, ...META_TYPES]) console.log(`  ${cfg.db}.${names[t]}`);
        console.log(`\n  Housemates keep their own rooms beside these. A bare 'messages' is not a table you have.`);
      }
      break;
    }
    case 'plugins': process.exitCode = await cmdPlugins(); break;
    case 'prompt':
      // Two audiences, two prompts. Bare `prompt` is the memory-USAGE snippet that goes
      // into a running agent's system prompt; `--install` is the one you hand an agent
      // that has not installed memhouse yet.
      if (flags.install === true) process.exitCode = await renderInstallPrompt();
      else {
        // Render THIS machine's state. The snippet used to be a straight file dump that
        // told the agent the database was 'mem' and the config was at ~/.memhouse/env —
        // wrong for anyone whose house or MEMHOUSE_HOME differs, which is the whole point
        // of having those knobs. `--install` already renders; bare `prompt` did not.
        const pcfg = resolveConfig();
        process.stdout.write(fs.readFileSync(path.join(DELIVERY, 'PROMPT.md'), 'utf-8')
          .replaceAll('{{DB}}', pcfg.db)
          .replaceAll('{{ENV_FILE}}', ENV_FILE));
      }
      break;
    case 'reset': process.exitCode = await cmdReset(); break;
    case 'share': process.exitCode = await cmdShare(); break;
    case 'whoami': process.exitCode = await cmdWhoami(); break;
    case 'invite': process.exitCode = await cmdInvite(); break;
    case 'passwd': process.exitCode = await cmdPasswd(); break;
    case 'nightly': process.exitCode = await cmdNightly(); break;
    case 'migrate': process.exitCode = await cmdMigrate({}); break;
    case 'migrate-rooms': process.exitCode = await cmdMigrate({ component: 'rooms' }); break;
    case 'relocate': process.exitCode = await cmdRelocate(); break;
    case 'deploy': {
      const dep = require(path.join(REPO_ROOT, 'memhouse', 'deploy.js'));
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
        try { svcCfg = require(path.join(REPO_ROOT, 'memhouse', 'service.js')).installedConfig(); } catch { /* unsupported */ }
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
        // Ask. This removes the data VOLUME as well as the container — measured, 810 MB of
        // a real house — and it was the only destructive command in the product that did
        // not confirm, while `reset`, which merely re-ships, does. `prompt --install` had
        // to tell agents in prose not to run it.
        if (flags.yes !== true) {
          const held = await (async () => {
            try {
              const c = resolveConfig();
              const n = await chRows(c, `SELECT count() AS n FROM ${(await roomsFor(c)).messages} FINAL`);
              return Number(n[0]?.n || 0);
            } catch { return null; }
          })();
          console.log(warn('this removes the container AND its data volume — the house and everything in it.'));
          if (held) console.log(`  ${held.toLocaleString()} messages are stored there. Re-shipping recovers only what the adapters can still see.`);
          const a = (await ask('Remove it? (yes/no)', 'no')).toLowerCase();
          if (a !== 'yes' && a !== 'y') { console.log('aborted'); process.exitCode = 1; break; }
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
      // The credential that initialised the volume is the SUPERUSER's. In a one-layout house
      // that is the admin credential kept beside the member's; in a house from before
      // fencing the member was the superuser, so it is the member's.
      const reusable = initialised && configIsLocalHouse && (priorCfg.adminPassword || priorCfg.password)
        ? (priorCfg.adminPassword || priorCfg.password) : null;

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
        console.log(`  to rotate:   ALTER USER ${priorCfg.user || 'memhouse_root'} IDENTIFIED BY '…' inside the house, then: memhouse setup --password …`);
        console.log('  to start over (DESTROYS the memory):  memhouse deploy --down');
        process.exitCode = 2; break;
      }
      // Who owns this house. A local deploy is the pilot's own machine and their own
      // memory, so the house user is THEM — suggested from the OS username (`polat`, not
      // `memhouse_root`) — created by the container itself at first init with full
      // rights. No admin/member split, no provisioning dance: a URI and a credential is
      // the whole install. The name is fixed at volume init exactly like the password,
      // so an existing house keeps the user it was born with.
      const osName = (os.userInfo().username || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^[0-9_]+/, '');
      let houseUser;
      if (initialised) {
        // The env FILE, not resolveConfig(): flags outrank the file there, so comparing
        // `--user other` against priorCfg.user compares the flag against itself and the
        // refusal below can never fire — while the volume stays initialised with the
        // original name and every later connection fails auth.
        const storedUser = readEnvFile().MEMHOUSE_USER;
        // No stored user means the env file is gone or emptied — the stored PASSWORD is
        // gone with it, so the `initialised && !reusable` refusal below already owns this
        // case. Refusing `--user` here on a guessed 'memhouse_root' would tell the pilot
        // their house "was initialised with memhouse_root" on no evidence at all.
        if (storedUser && flags.user && flags.user !== true && flags.user !== storedUser) {
          console.log(bad(`--user cannot rename the user of an existing house — the image creates it only when it initialises the data directory.`));
          console.log(`  this house was initialised with '${storedUser}'. To start over (DESTROYS the memory):  memhouse deploy --down`);
          process.exitCode = 2; break;
        }
        houseUser = storedUser || 'memhouse_root';
      } else if (flags.user && flags.user !== true) {
        houseUser = String(flags.user);
      } else if (flags.yes !== true && process.stdin.isTTY) {
        houseUser = (await ask(`House user (this becomes your member name)`, osName || 'memhouse_root')).trim() || osName || 'memhouse_root';
      } else {
        houseUser = osName || 'memhouse_root';
      }
      try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(houseUser, 'house user'); }
      catch (e) { console.log(bad(`'${houseUser}' cannot be the house user — ${e.message}`)); process.exitCode = 2; break; }
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
      // STATED sources only, then the house user. priorCfg.db is unusable here: resolveConfig
      // computes a DEFAULT for it (the user's name, itself defaulted), so going through it
      // handed a fresh deploy `memhouse_root` as the house name while the superuser was
      // 'polat' — the memory would live in a database named after a role account nobody
      // chose.
      const targetDb = flags.db || process.env.MEMHOUSE_DB || readEnvFile().MEMHOUSE_DB || 'mem';
      // Same check install runs, but EARLY — deploy initialises the container volume and
      // writes the env file before its install step, so a refusal that waits for install
      // arrives after the damage.
      try { require(path.join(REPO_ROOT, 'memhouse', 'house', 'house')).assertUsableName(targetDb, 'house'); }
      catch (e) { console.log(bad(e.message)); process.exitCode = 2; break; }
      {
        // A service-managed shipper keeps the environment it was installed with, so ANY
        // switch that repoints the config leaves it shipping somewhere else — not only an
        // explicit port move. A bare `deploy --local` over a config pointing at an
        // external house is the case that used to slip through: `to` was empty, the check
        // was skipped, and `status` would then report a running shipper beside counts
        // from a different house.
        let svcCfg = { installed: false, url: null };
        try { svcCfg = require(path.join(REPO_ROOT, 'memhouse', 'service.js')).installedConfig(); } catch { /* unsupported */ }
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
      // ONE LAYOUT from the first install. The container's superuser is the ADMIN
      // credential (`memhouse_root`); the person shipping is a fenced MEMBER named for them,
      // holding one grant on mem.<name>_*. A house of one is still a house — inviting a
      // colleague later is one more member, never a change to this one. A volume that
      // predates fencing was initialised with the member as superuser; it is reused as it
      // is, and doctor says how to fence it.
      const superUser = initialised ? (priorCfg.adminUser || houseUser) : 'memhouse_root';
      const pw = reusable || crypto.randomBytes(16).toString('hex');
      const memberPw = reusable ? (priorCfg.password || pw) : (houseUser === superUser ? pw : crypto.randomBytes(16).toString('hex'));
      if (reusable) console.log(ok('reusing the existing house credential (its data volume is already initialised)'));
      const r = dep.up({ password: pw, port, tag, user: superUser });
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
        // db INCLUDED: this file is read back by the install below, and writing
        // priorCfg's computed default here made that install refuse over a mismatch
        // with a file this same command had just written.
        writeEnvFile({ ...priorCfg, url: r.url, user: houseUser, password: memberPw, db: targetDb, adminUser: superUser, adminPassword: pw });
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
      // Fence the member from the start, with the same plan `invite` runs: mem.<name>_* and
      // nothing else. Idempotent, so a reused house gets the same pass and nothing changes.
      if (houseUser !== superUser) {
        const { plan } = require(path.join(REPO_ROOT, 'memhouse', 'provision'));
        const adminCfg = { url: r.url, user: superUser, password: pw, db: targetDb, stated: true };
        let failed = null;
        try {
          for (const step of plan({ db: targetDb, member: houseUser, password: reusable ? null : memberPw })) {
            try { await ch(adminCfg, step.sql, { database: '' }); }
            catch (e) { if (!step.optional) throw e; }
          }
        } catch (e) { failed = e; }
        if (failed) {
          console.log(bad(`could not provision member '${houseUser}': ${String(failed.message).split('\n')[0]}`));
          console.log(`  the house is up and the admin credential is in ${ENV_FILE.replace(os.homedir(), '~')}; fix and re-run deploy --local.`);
          process.exitCode = 1; break;
        }
        console.log(ok(`member '${houseUser}' holds ${targetDb}.${houseUser}_* and nothing else; '${superUser}' administers the house`));
      } else if (initialised && !priorCfg.adminUser) {
        console.log(warn(`'${houseUser}' is both member and superuser here — this house predates fencing. It works; \`memhouse doctor\` says how to fence it.`));
      }
      // A ROOTLESS container lives in the user's systemd slice, which MAY be torn down at
      // logout — if so the container takes a SIGTERM and the house goes with it. The
      // volume survives, so nothing is lost, but the house is gone with no explanation.
      //
      // Whether it happens depends on logind's KillUserProcesses. Measured once on a
      // testbed VM as `Exited (143)` twenty seconds after the ssh session ended; measured
      // again later on Ubuntu 24.04, which ships KillUserProcesses=no, and the container
      // and the user manager both survived 44 seconds with zero sessions and Linger=no.
      // So the warning is conditional, and it is worded as a possibility rather than a
      // certainty: enabling lingering is harmless and makes it moot either way, but
      // telling a user to fix a problem their distro does not have costs credibility on
      // every other thing this command says.
      //
      // `service install` already detects exactly this for its own unit. The container
      // needs the same check, and podman is the case that matters: it is rootless by
      // default, where docker is conventionally a system daemon that outlives logout
      // (rootless docker has the same exposure, but is the deliberate minority).
      if (process.platform === 'linux' && r.engine === 'podman') {
        let lingering = true;
        try { lingering = require(path.join(REPO_ROOT, 'memhouse', 'service.js')).lingerEnabled(); } catch { /* assume fine */ }
        if (!lingering) {
          console.log(warn('rootless podman: this container MAY stop when you log out (lingering is off).'));
          console.log('  Whether it does depends on your distro — Ubuntu 24.04 keeps it, others kill it.');
          console.log(`  To make it moot:  loginctl enable-linger ${os.userInfo().username}`);
          // Repeat the port that was actually used. cmdPlugins already knows to echo back
          // the --target it was given; this line dropped --house-port, so following it
          // would stand the house up somewhere else.
          console.log(`  If it does stop: memhouse deploy --local${flags['house-port'] ? ` --house-port ${flags['house-port']}` : ''}   (the data volume persists)`);
        }
      }
      // Say what this credential is. `deploy --local` stands up a house you own, so the
      // member IS the superuser — SHOW GRANTS for it includes CREATE USER, FILE, URL,
      // REMOTE and S3, all WITH GRANT OPTION, and `service install` inlines it into a
      // systemd unit. That is a defensible position for a single-owner house (DESIGN.md
      // anticipates it) and it is NOT the narrow set INSTALL.md's grant-set argument
      // describes. A user who later adds a second member should know which house they
      // have.
      if (houseUser !== superUser) {
        console.log(ok(`'${houseUser}' ships as a member of ${targetDb}; '${superUser}' administers it — both credentials are in the env file`));
        console.log('  Adding a housemate later:  memhouse invite <name> --url <an address they can reach>');
      } else {
        console.log(warn(`this house is yours alone: '${houseUser}' is its superuser, and that is the credential being saved`));
      }
      // The install below runs AS THE MEMBER, with the member's password — not the
      // superuser's, which is what this handed it before the two were separated. The admin
      // credential is NOT passed as flags: that would send install down the provisioning
      // path for a member that already exists. It is already in the env file written above,
      // and resolveConfig() carries it through to the file install rewrites.
      flags.url = r.url; flags.user = houseUser; flags.password = memberPw;
      flags.db = targetDb;
      flags.yes = true;
      process.exitCode = await cmdInstall({ interactive: false });
      break;
    }
    case 'service': {
      const svc = require(path.join(REPO_ROOT, 'memhouse', 'service.js'));
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
          // Replacing a service that belongs to a DIFFERENT MEMHOUSE_HOME is refused
          // unless asked for; there is one service name per user, so the replacement is
          // otherwise silent and the other house is left with no shipper.
          force: flags.force === true,
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
      } else if (sub === 'stop' || sub === 'start' || sub === 'restart') {
        // These existed only as advice text for a while — and the advice named
        // `memhouse service stop`, which fell through to status. A command a message
        // tells you to run has to exist.
        const st = svc.status();
        if (!st.kind || !st.installed) { console.log(warn('service not installed')); process.exitCode = 1; break; }
        const args = st.kind === 'systemd'
          ? [['systemctl', ['--user', sub, 'memhouse-shipper']]]
          : (sub === 'stop'
            ? [['launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.shipper`]]]
            : sub === 'start'
              ? [['launchctl', ['bootstrap', `gui/${process.getuid()}`, st.path]]]
              : [['launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.memhouse.shipper`]]]);
        let failed = false;
        for (const [b, a] of args) {
          const r = spawnSync(b, a, { stdio: 'pipe', encoding: 'utf-8' });
          if (r.status !== 0) { console.log(bad(`${b} ${a.join(' ')}: ${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}`)); failed = true; }
        }
        if (!failed) console.log(ok(`service ${sub === 'stop' ? 'stopped' : sub === 'start' ? 'started' : 'restarted'} (${st.kind})`));
        process.exitCode = failed ? 1 : 0;
      } else {
        const st = svc.status();
        if (!st.kind) { console.log(warn(`no service integration for '${process.platform}'`)); break; }
        console.log(st.installed ? ok(`service installed (${st.kind}): ${st.path}`) : warn('service not installed'));
        console.log(st.running ? ok('service running') : warn('service not running'));
      }
      break;
    }
    case 'uninstall': await cmdUninstall(); break;
    default:
      console.error(`unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 2;
  }
})().catch((e) => { console.error(bad(e.message)); process.exit(1); });
