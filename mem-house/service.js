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
const SOLO_LABEL = 'memhouse-solo';
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
    systemdSolo: path.join(home, '.config', 'systemd', 'user', `${SOLO_LABEL}.service`),
    launchdSolo: path.join(home, 'Library', 'LaunchAgents', 'com.memhouse.solo.plist'),
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

function systemdUnit({ node, script, args, env, logDir, logName, description, after = [] }) {
  const wants = after.length ? `${after.map((u) => `Wants=${u}`).join('\n')}\n${after.map((u) => `After=${u}`).join('\n')}\n` : '';
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target
${wants}
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
 * `service install` takes over from the detached daemons by killing them first. If the
 * install then fails — no user manager on Linux, `launchctl bootstrap` refusing on macOS,
 * a credential with a newline in it — the machine is left with no shipper at all, and on
 * the solo tier with no house either. So the answerable questions are asked first.
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

/**
 * Install the shipper as a user service.
 *
 * `soloJs` opts in to the solo tier: the shipper then talks to an embedded chdb behind a
 * local shim, and a service that starts only the shipper would come back from a reboot
 * pointed at a port with nothing behind it. So the shim gets its own unit, and on Linux
 * the shipper is ordered after it.
 */
function install({ shipJs, envFile, logDir, interval = 300, soloJs = null, soloPort = null, home = null, soloData = null }) {
  const kind = platform();
  if (!kind) return { ok: false, msg: `no service integration for platform '${process.platform}'` };
  const paths = unitPaths();
  const p = paths[kind];
  const soloPath = kind === 'systemd' ? paths.systemdSolo : paths.launchdSolo;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const node = process.execPath;

  // The whole persisted config, so MEM_PER_MEMBER travels with it: a per-member install
  // whose service forgot the layout switch would come back after a reboot writing to the
  // shared rooms — which either fails on permissions or, on a house that still has them,
  // quietly ships into the wrong place.
  const env = parseEnvFile(envFile);
  if (soloPort) env.MEMHOUSE_SOLO_PORT = String(soloPort);
  // MEMHOUSE_HOME is not in the env file — it is where the env file itself lives — but the
  // solo shim derives its data directory from it. A service installed under a custom home
  // would otherwise open the DEFAULT ~/.memhouse/solo-data: an empty directory with no
  // schema, so the old memory looks gone and the shipper retries forever against a house
  // that has nothing in it. Inline the effective paths.
  if (home) env.MEMHOUSE_HOME = home;
  if (soloData) env.MEMHOUSE_SOLO_DATA = soloData;
  // Adapter location overrides travel too. A detached shipper inherits them from the
  // invoking shell through childEnv(); a service inherits nothing, so an override that
  // was working before `service install` silently stops applying — the adapter falls back
  // to its default path and just stops finding sessions, with no error anywhere.
  for (const k of ADAPTER_ENV) if (process.env[k]) env[k] = process.env[k];
  try { envfile.assertSingleLine(env); } catch (e) { return { ok: false, msg: e.message }; }

  if (kind === 'systemd') {
    if (soloJs) {
      fs.writeFileSync(soloPath, systemdUnit({
        node, script: soloJs, args: [], env, logDir, logName: 'solo.log',
        description: 'memhouse solo house — embedded chdb behind a local ClickHouse-HTTP shim',
      }), { mode: 0o600 });
    } else if (fs.existsSync(soloPath)) {
      // Switching tiers must not leave the previous tier's unit running.
      spawnSync('systemctl', ['--user', 'disable', '--now', `${SOLO_LABEL}.service`]);
      fs.unlinkSync(soloPath);
    }
    fs.writeFileSync(p, systemdUnit({
      node, script: shipJs, args: ['--loop', String(interval)], env, logDir, logName: 'shipper.log',
      description: 'memhouse shipper — parse local agent sessions and ship to the house',
      after: soloJs ? [`${SOLO_LABEL}.service`] : [],
    }), { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    // `enable --now` STARTS a unit; it does not restart one that is already running, and
    // a running unit keeps the environment it was started with. Re-installing after
    // changing the connection, the interval, CODEX_HOME or the tier would then report
    // success while the service went on shipping with the old settings until a reboot.
    // So: enable, then restart — which starts a stopped unit and replaces a running one.
    for (const unit of [...(soloJs ? [`${SOLO_LABEL}.service`] : []), `${LABEL}.service`]) {
      execFileSync('systemctl', ['--user', 'enable', unit]);
      execFileSync('systemctl', ['--user', 'restart', unit]);
    }
    const warn = lingerEnabled() ? null
      : `systemd --user services stop at logout. Run: loginctl enable-linger ${os.userInfo().username}`;
    return { ok: true, kind, path: p, soloPath: soloJs ? soloPath : null, warn };
  }

  // launchd. Both plists inline the credential, so neither may be world-readable.
  // launchd has no ordering between agents; the shipper's own retry loop covers the
  // window where the shim has not finished starting.
  if (soloJs) {
    fs.writeFileSync(soloPath, launchdPlist({
      node, script: soloJs, args: [], env, logDir, logName: 'solo.log', label: 'com.memhouse.solo',
    }), { mode: 0o600 });
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.solo`]);
    const rs = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, soloPath], { encoding: 'utf-8' });
    if (rs.status !== 0) return { ok: false, msg: (rs.stderr || '').trim() || 'launchctl bootstrap failed (solo)', path: soloPath };
  } else if (fs.existsSync(soloPath)) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.solo`]);
    fs.unlinkSync(soloPath);
  }
  fs.writeFileSync(p, launchdPlist({
    node, script: shipJs, args: ['--loop', String(interval)], env, logDir,
    logName: 'shipper.log', label: 'com.memhouse.shipper',
  }), { mode: 0o600 });
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.shipper`]); // ignore if absent
  const r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, p], { encoding: 'utf-8' });
  if (r.status !== 0) return { ok: false, msg: (r.stderr || '').trim() || 'launchctl bootstrap failed', path: p };
  return { ok: true, kind, path: p, soloPath: soloJs ? soloPath : null, warn: null };
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
  const paths = unitPaths();
  const p = paths[kind];
  const soloPath = kind === 'systemd' ? paths.systemdSolo : paths.launchdSolo;
  const stillRunning = [];
  const indeterminate = [];

  const units = kind === 'systemd'
    ? [[`${LABEL}.service`, p, 'com.memhouse.shipper'], [`${SOLO_LABEL}.service`, soloPath, 'com.memhouse.solo']]
    : [['com.memhouse.shipper', p, 'com.memhouse.shipper'], ['com.memhouse.solo', soloPath, 'com.memhouse.solo']];

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
    if (['inactive', 'failed', 'activating', 'deactivating', 'unknown'].includes(out)) {
      return out === 'activating' ? 'running' : 'stopped';
    }
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

function status() {
  const kind = platform();
  if (!kind) return { kind: null, installed: false, running: false };
  const paths = unitPaths();
  const p = paths[kind];
  const soloPath = kind === 'systemd' ? paths.systemdSolo : paths.launchdSolo;
  const soloInstalled = fs.existsSync(soloPath);
  return {
    kind,
    installed: fs.existsSync(p),
    running: isRunning(kind, `${LABEL}.service`, 'com.memhouse.shipper'),
    path: p,
    solo: soloInstalled
      ? { installed: true, running: isRunning(kind, `${SOLO_LABEL}.service`, 'com.memhouse.solo'), path: soloPath }
      : { installed: false, running: false, path: soloPath },
  };
}

// The two renderers are exported so the unit gate can check what gets written without
// installing anything. A malformed plist or unit is only visible at load time otherwise,
// and "load it and see" is not available on a machine you must not touch.
module.exports = {
  install, uninstall, status, platform, preflight,
  _render: { systemdUnit, launchdPlist, unitPaths },
};
