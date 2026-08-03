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
ExecStart=${node} ${script}${args.length ? ` ${args.join(' ')}` : ''}
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
 * Install the shipper as a user service.
 *
 * `soloJs` opts in to the solo tier: the shipper then talks to an embedded chdb behind a
 * local shim, and a service that starts only the shipper would come back from a reboot
 * pointed at a port with nothing behind it. So the shim gets its own unit, and on Linux
 * the shipper is ordered after it.
 */
function install({ shipJs, envFile, logDir, interval = 300, soloJs = null, soloPort = null }) {
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
    if (soloJs) execFileSync('systemctl', ['--user', 'enable', '--now', `${SOLO_LABEL}.service`]);
    execFileSync('systemctl', ['--user', 'enable', '--now', `${LABEL}.service`]);
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

function uninstall() {
  const kind = platform();
  if (!kind) return { ok: false, msg: `no service integration for platform '${process.platform}'` };
  const paths = unitPaths();
  const p = paths[kind];
  const soloPath = kind === 'systemd' ? paths.systemdSolo : paths.launchdSolo;
  if (kind === 'systemd') {
    for (const [unit, file] of [[`${LABEL}.service`, p], [`${SOLO_LABEL}.service`, soloPath]]) {
      spawnSync('systemctl', ['--user', 'disable', '--now', unit]);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    spawnSync('systemctl', ['--user', 'daemon-reload']);
  } else {
    for (const [lbl, file] of [['com.memhouse.shipper', p], ['com.memhouse.solo', soloPath]]) {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${lbl}`]);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  return { ok: true, kind, path: p };
}

function isRunning(kind, unit, label) {
  if (kind === 'systemd') {
    return spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf-8' }).stdout.trim() === 'active';
  }
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf-8' });
  return r.status === 0 && /state = running|state = waiting/.test(r.stdout || '');
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
module.exports = { install, uninstall, status, platform, _render: { systemdUnit, launchdPlist, unitPaths } };
