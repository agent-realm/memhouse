// OS service integration — survive a reboot.
//
// `memhouse start` detaches the shipper and dashboard with pidfiles. They outlive the
// shell, but nothing brings them back after a restart, so a machine that reboots stops
// shipping until someone notices. This installs a real user-level service instead:
// systemd --user on Linux, launchd LaunchAgent on macOS.
//
// User-level deliberately, not system-level: the shipper reads the invoking user's own
// session stores (~/.claude, ~/.codex, editor SQLite files) and ships under their own
// credential. A root service would read the wrong home and stamp the wrong user_id.
//
// The whole environment is INLINED into the unit on both platforms, and both files are
// written 0600. systemd could read the env file directly, but ~/.memhouse/env is written
// in shell quoting so it can be `source`d, and systemd does not understand the `'\''`
// escape a password with a quote in it produces — it would start the shipper with a
// subtly different credential. One env representation, decoded once, per platform.
//
// Linux caveat: a systemd --user unit stops at logout unless lingering is enabled
// (`loginctl enable-linger <user>`). We detect and say so rather than silently
// installing something that dies on logout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const envfile = require('./envfile');

const LABEL = 'memhouse-shipper';
// Environment an ADAPTER reads to find its sessions, as opposed to the connection
// settings that live in the env file. Keep this in step with `editors/` — today
// `editors/codex.js` is the only adapter with an override.
const ADAPTER_ENV = ['CODEX_HOME'];

function platform() {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  return null;
}

function unitPaths() {
  const home = os.homedir();
  return {
    systemd: path.join(home, '.config', 'systemd', 'user', `${LABEL}.service`),
    launchd: path.join(home, 'Library', 'LaunchAgents', 'com.memhouse.shipper.plist'),
  };
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function envLines(env) {
  return Object.entries(env).map(([k, v]) => `Environment=${k}=${envfile.quoteSystemd(v)}`).join('\n');
}

// systemd splits ExecStart on whitespace, so an unquoted path containing a space becomes
// several arguments and the unit cannot start — `ExecStart=/tmp/a b/node …` resolves the
// executable as `/tmp/a`. Node itself lives under a space-bearing path often enough
// (`~/Library/Application Support/...`, `C:\Program Files` equivalents under WSL, any
// checkout in a folder with a space) that this is not exotic. Double quotes with C escapes
// are systemd's own syntax, the same rule `Environment=` uses.
function execToken(s) {
  return /[\s"'\\]/.test(String(s)) ? envfile.quoteSystemd(s) : String(s);
}

function systemdUnit({ node, script, args, env, logDir, logName, description }) {
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${envLines(env)}
ExecStart=${[node, script, ...args].map(execToken).join(' ')}
Restart=on-failure
RestartSec=30
StandardOutput=append:${path.join(logDir, logName)}
StandardError=append:${path.join(logDir, logName)}

[Install]
WantedBy=default.target
`;
}

function launchdPlist({ node, script, args, env, logDir, logName, label }) {
  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  const argEntries = [node, script, ...args]
    .map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argEntries}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, logName))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, logName))}</string>
</dict>
</plist>
`;
}

function parseEnvFile(file) {
  try { return envfile.parse(fs.readFileSync(file, 'utf-8')); } catch { return {}; }
}

function lingerEnabled() {
  try {
    const r = spawnSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger'], { encoding: 'utf-8' });
    return /Linger=yes/.test(r.stdout || '');
  } catch { return false; }
}

/**
 * Everything install would fail on, asked before the caller stops anything.
 *
 * `service install` takes over from the detached shipper by killing it first. If the
 * install then fails — no user manager on Linux, `launchctl bootstrap` refusing on macOS,
 * a credential with a newline in it — the machine is left with no shipper at all. So the
 * answerable questions are asked first.
 */
function preflight({ envFile }) {
  const kind = platform();
  if (!kind) return { ok: false, msg: `no service integration for platform '${process.platform}'` };
  try { envfile.assertSingleLine(parseEnvFile(envFile)); } catch (e) { return { ok: false, msg: e.message }; }
  if (kind === 'systemd') {
    const r = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf-8' });
    if (r.error) return { ok: false, msg: 'systemctl is not on PATH — no systemd user manager to install into' };
    if (r.status !== 0) {
      return { ok: false, msg: 'cannot reach the systemd user manager '
        + `(${((r.stderr || '').trim().split('\n')[0]) || `exit ${r.status}`}). Is XDG_RUNTIME_DIR set for this session?` };
    }
  } else {
    const r = spawnSync('launchctl', ['print', `gui/${process.getuid()}`], { encoding: 'utf-8' });
    if (r.error) return { ok: false, msg: 'launchctl is not on PATH — no launchd session to install into' };
    // A non-zero status is a refusal too, and the systemd branch already treats it as
    // one. Over SSH there is often no accessible GUI domain, so `bootstrap` would fail —
    // after the caller had already stopped the shipper and the shim it was replacing.
    if (r.status !== 0) {
      return { ok: false, msg: `no accessible launchd GUI domain for uid ${process.getuid()} `
        + `(${((r.stderr || '').trim().split('\n')[0]) || `exit ${r.status}`}). `
        + 'A LaunchAgent needs a logged-in session; over SSH there may not be one.' };
    }
  }
  return { ok: true, kind };
}

/** Install the shipper as a user service. */
// What MEMHOUSE_* environment is baked into an already-installed unit? Both formats inline
// it (see the note at the top), so this reads the file rather than asking the init system.
function readInstalledEnv(unitPath) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(unitPath, 'utf-8'); } catch { return out; }
  for (const m of text.matchAll(/^Environment=([A-Z0-9_]+)=(.*)$/gm)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  // launchd: <key>NAME</key><string>VALUE</string> inside EnvironmentVariables
  for (const m of text.matchAll(/<key>([A-Z0-9_]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

function install({ shipJs, envFile, logDir, interval = 300, home = null, force = false }) {
  const kind = platform();
  if (!kind) return { ok: false, msg: `no service integration for platform '${process.platform}'` };
  const p = unitPaths()[kind];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const node = process.execPath;

  // The whole persisted config, so the house a unit points at travels with it: an install
  // whose service forgot the layout switch would come back after a reboot writing to the
  // another member's rooms — which either fails on permissions or, if it can read them,
  // quietly ships into the wrong place.
  const env = parseEnvFile(envFile);
  // MEMHOUSE_HOME is not in the env file — it is where the env file itself lives — and a
  // service installed under a custom home must keep using it, or it reads a different
  // config after a reboot than the one just written.
  if (home) env.MEMHOUSE_HOME = home;

  // One label per user, so a SECOND install under a different MEMHOUSE_HOME would
  // `bootout` the first and take the name — silently, reporting success, leaving the
  // original house with no shipper and nothing to say so. Refuse instead, and name both
  // sides. (Namespacing the label per home would fix it more thoroughly but orphans every
  // service already installed under the current one; a refusal loses nothing.)
  const existingHome = fs.existsSync(p) ? (readInstalledEnv(p).MEMHOUSE_HOME || '') : null;
  const wantHome = env.MEMHOUSE_HOME || '';
  if (existingHome !== null && existingHome !== wantHome && !force) {
    return {
      ok: false,
      msg: `a memhouse service is already installed for a different config\n`
        + `    installed: MEMHOUSE_HOME=${existingHome || '(default)'}\n`
        + `    this run:  MEMHOUSE_HOME=${wantHome || '(default)'}\n`
        + `  Both would use the same service name, so installing would silently replace the\n`
        + `  other one. Uninstall it first (memhouse service uninstall), or pass --force.`,
      path: p,
    };
  }
  // Adapter location overrides travel too. A detached shipper inherits them from the
  // invoking shell through childEnv(); a service inherits nothing, so an override that
  // was working before `service install` silently stops applying — the adapter falls back
  // to its default path and just stops finding sessions, with no error anywhere.
  for (const k of ADAPTER_ENV) if (process.env[k]) env[k] = process.env[k];
  // Tells the shipper it has a supervisor. On an upgrade a supervised daemon EXITS and lets
  // systemd/launchd start the new version; an unsupervised one re-execs itself, because
  // nothing else would. Getting this backwards is the expensive direction: a process that
  // re-execs under a supervisor races the unit's own restart, and two shippers on one house
  // clear each other's rows. See memhouse/self-update.js.
  env.MEMHOUSE_SUPERVISED = '1';
  try { envfile.assertSingleLine(env); } catch (e) { return { ok: false, msg: e.message }; }

  if (kind === 'systemd') {
    fs.writeFileSync(p, systemdUnit({
      node, script: shipJs, args: ['--loop', String(interval)], env, logDir, logName: 'shipper.log',
      description: 'memhouse shipper — parse local agent sessions and ship to the house',
    }), { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    // `enable --now` STARTS a unit; it does not restart one that is already running, and
    // a running unit keeps the environment it was started with. Re-installing after
    // changing the connection, the interval, CODEX_HOME or the tier would then report
    // success while the service went on shipping with the old settings until a reboot.
    // So: enable, then restart — which starts a stopped unit and replaces a running one.
    for (const unit of [`${LABEL}.service`]) {
      execFileSync('systemctl', ['--user', 'enable', unit]);
      execFileSync('systemctl', ['--user', 'restart', unit]);
    }
    const warn = lingerEnabled() ? null
      // Hedged, like the deploy --local warning, and for the same measured reason: whether
      // a --user unit survives logout depends on logind's KillUserProcesses, which Ubuntu
      // 24.04 sets to no. Stating it as a certainty on a distro where it is false costs
      // credibility on everything else the command says.
      : `systemd --user services MAY stop at logout — it depends on your distro (Ubuntu 24.04 keeps them). To make it moot: loginctl enable-linger ${os.userInfo().username}`;
    return { ok: true, kind, path: p, warn };
  }

  // launchd. The plist inlines the credential, so it must not be world-readable.
  fs.writeFileSync(p, launchdPlist({
    node, script: shipJs, args: ['--loop', String(interval)], env, logDir,
    logName: 'shipper.log', label: 'com.memhouse.shipper',
  }), { mode: 0o600 });
  // bootout is asynchronous: it returns before launchd has finished tearing the job down,
  // and a bootstrap issued in that window fails with `Service is being removed` (EBUSY,
  // 36). Reinstalling over a RUNNING service is exactly when that happens, which is the
  // common case — `service install` after a redeploy. Wait for the label to actually go.
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.shipper`]); // ignore if absent
  for (let i = 0; i < 50; i++) {
    const q = spawnSync('launchctl', ['print', `gui/${process.getuid()}/com.memhouse.shipper`], { encoding: 'utf-8' });
    if (q.status !== 0) break; // gone
    spawnSync('sleep', ['0.1']);
  }
  const r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, p], { encoding: 'utf-8' });
  if (r.status !== 0) return { ok: false, msg: (r.stderr || '').trim() || 'launchctl bootstrap failed', path: p };
  return { ok: true, kind, path: p, warn: null };
}

/**
 * Remove the units — but only after they are actually stopped.
 *
 * Deleting a unit file does not stop a loaded service. If `disable --now` fails (a
 * lingering user service running under a manager this shell cannot reach, say), removing
 * the file leaves a shipper running with the credential inlined in a file the caller is
 * about to delete, while every command reports the install gone. So: verify stopped, and
 * refuse rather than report a success that is not one.
 */
function uninstall() {
  const kind = platform();
  if (!kind) return { ok: false, msg: `no service integration for platform '${process.platform}'` };
  const p = unitPaths()[kind];
  const stillRunning = [];
  const indeterminate = [];

  const units = kind === 'systemd'
    ? [[`${LABEL}.service`, p, 'com.memhouse.shipper']]
    : [['com.memhouse.shipper', p, 'com.memhouse.shipper']];

  for (const [unit, file, label] of units) {
    if (!fs.existsSync(file)) continue;
    if (kind === 'systemd') spawnSync('systemctl', ['--user', 'disable', '--now', unit], { encoding: 'utf-8' });
    else spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { encoding: 'utf-8' });
    // The command's own status is not the question — `disable` can report success while
    // the unit stays active, and `bootout` returns non-zero for an already-absent job.
    // Ask what state it is in now, and treat "cannot tell" as its own answer: deleting
    // the unit on an unknown state is how a live shipper keeps running with a credential
    // in a file everyone believes is gone.
    const state = runState(kind, unit, label);
    if (state === 'running') { stillRunning.push(unit); continue; }
    if (state === 'unknown') { indeterminate.push(unit); continue; }
    fs.unlinkSync(file);
  }
  if (kind === 'systemd') spawnSync('systemctl', ['--user', 'daemon-reload']);

  if (stillRunning.length) {
    return {
      ok: false,
      kind,
      path: p,
      msg: `${stillRunning.join(', ')} is still running after stop — unit file kept. `
        + `Stop it yourself (systemctl --user stop ${stillRunning[0]}), then re-run.`,
    };
  }
  if (indeterminate.length) {
    return {
      ok: false,
      kind,
      path: p,
      msg: `cannot determine whether ${indeterminate.join(', ')} stopped — no usable `
        + `${kind === 'systemd' ? 'systemctl' : 'launchctl'} on this host, so the unit file is kept. `
        + 'Confirm it is stopped, remove the unit yourself, then re-run.',
    };
  }
  return { ok: true, kind, path: p };
}

// Three states, not two. A missing service manager is a normal state and not a crash —
// `spawnSync` on an absent binary returns { error, stdout: null }, and dereferencing that
// took down `uninstall`, `status` and `doctor` on any Linux host without systemctl. But
// collapsing that into "not running" is its own bug: teardown would then treat "cannot
// tell" as "confirmed stopped" and delete the unit and the credential out from under a
// shipper that is still going. Display may round `unknown` down; teardown must not.
function runState(kind, unit, label) {
  if (kind === 'systemd') {
    const r = spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf-8' });
    if (r.error) return 'unknown';               // no systemctl on PATH
    const out = (r.stdout || '').trim();
    if (out === 'active') return 'running';
    // `is-active` answers inactive/failed/activating on a manager it can reach. Anything
    // else — empty output, a connection error on stderr — means it could not tell us.
    // `deactivating` is a unit still shutting down, not one that has stopped. Calling it
    // stopped let uninstall delete a credential-bearing unit whose process was still
    // alive. Both transitional states count as running, so teardown keeps the file and
    // refuses until systemd reports a terminal state.
    if (['activating', 'deactivating'].includes(out)) return 'running';
    if (['inactive', 'failed'].includes(out)) return 'stopped';
    return 'unknown';
  }
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf-8' });
  if (r.error) return 'unknown';                 // no launchctl
  if (r.status === 0) return /state = running|state = waiting/.test(r.stdout || '') ? 'running' : 'stopped';
  // Non-zero has two very different meanings. "Could not find service" is launchd
  // telling us the job is gone — a real `stopped`. "Could not find domain" is launchd
  // telling us it cannot look, which happens over SSH with no GUI session, and treating
  // that as stopped let `uninstall` delete a plist while its shipper kept running with
  // the inlined credential.
  const out = `${r.stderr || ''}${r.stdout || ''}`;
  if (/could not find service|no such process|not find the specified service/i.test(out)) return 'stopped';
  return 'unknown';
}

function isRunning(kind, unit, label) {
  return runState(kind, unit, label) === 'running';
}

/**
 * What the INSTALLED unit actually points at, read from the unit file rather than from
 * the current config — the two drift the moment anything is redeployed, and callers
 * asking "does this service care about the house I am removing?" need the unit's answer.
 *
 * Returns { installed, url, db } — null/false when undeterminable.
 */
function installedConfig() {
  const kind = platform();
  if (!kind) return { installed: false, url: null, db: null };
  const p = unitPaths()[kind];
  if (!fs.existsSync(p)) return { installed: false, url: null, db: null };
  let text = '';
  try { text = fs.readFileSync(p, 'utf-8'); } catch { return { installed: true, url: null, db: null }; }
  const env = {};
  if (kind === 'systemd') {
    for (const m of text.matchAll(/^Environment=([A-Z0-9_]+)=(.*)$/gm)) {
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
      env[m[1]] = v;
    }
  } else {
    // <key>NAME</key><newline><string>VALUE</string>
    for (const m of text.matchAll(/<key>([A-Z0-9_]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
      env[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }
  }
  return {
    installed: true,
    url: env.MEMHOUSE_URL || null,
    // The endpoint is not the whole identity. A service on the same URL but a different
    // DATABASE — or a different room layout — is still shipping somewhere else.
    db: env.MEMHOUSE_DB || null,
  };
}

function status() {
  const kind = platform();
  if (!kind) return { kind: null, installed: false, running: false };
  const p = unitPaths()[kind];
  return {
    kind,
    installed: fs.existsSync(p),
    running: isRunning(kind, `${LABEL}.service`, 'com.memhouse.shipper'),
    path: p,
  };
}

// The two renderers are exported so the unit gate can check what gets written without
// installing anything. A malformed plist or unit is only visible at load time otherwise,
// and "load it and see" is not available on a machine you must not touch.
module.exports = {
  install, uninstall, status, platform, preflight, installedConfig, lingerEnabled,
  _render: { systemdUnit, launchdPlist, unitPaths },
};
