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
// Linux caveat: a systemd --user unit stops at logout unless lingering is enabled
// (`loginctl enable-linger <user>`). We detect and say so rather than silently
// installing something that dies on logout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LABEL = 'memhouse-shipper';

function platform() {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  return null;
}

function unitPaths() {
  const home = os.homedir();
  return {
    systemd: path.join(home, '.config', 'systemd', 'user', `${LABEL}.service`),
    launchd: path.join(home, 'Library', 'LaunchAgents', `com.memhouse.shipper.plist`),
  };
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function systemdUnit({ node, shipJs, interval, envFile, logDir }) {
  return `[Unit]
Description=memhouse shipper — parse local agent sessions and ship to the house
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# EnvironmentFile carries MEMHOUSE_URL/USER/PASSWORD/DB. It holds a credential, so the
# unit does not restate them and the file keeps its own 0600.
EnvironmentFile=${envFile}
ExecStart=${node} ${shipJs} --loop ${interval}
Restart=on-failure
RestartSec=30
StandardOutput=append:${path.join(logDir, 'shipper.log')}
StandardError=append:${path.join(logDir, 'shipper.log')}

[Install]
WantedBy=default.target
`;
}

// launchd does not read EnvironmentFile, so the env is parsed from the same file and
// inlined. The plist therefore contains the credential and is written 0600.
function launchdPlist({ node, shipJs, interval, env, logDir }) {
  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.memhouse.shipper</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(shipJs)}</string>
    <string>--loop</string>
    <string>${xml(interval)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, 'shipper.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, 'shipper.log'))}</string>
</dict>
</plist>
`;
}

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function lingerEnabled() {
  try {
    const r = spawnSync('loginctl', ['show-user', os.userInfo().username, '--property=Linger'], { encoding: 'utf-8' });
    return /Linger=yes/.test(r.stdout || '');
  } catch { return false; }
}

function install({ shipJs, envFile, logDir, interval = 300 }) {
  const kind = platform();
  if (!kind) return { ok: false, msg: `no service integration for platform '${process.platform}'` };
  const p = unitPaths()[kind];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const node = process.execPath;

  if (kind === 'systemd') {
    fs.writeFileSync(p, systemdUnit({ node, shipJs, interval, envFile, logDir }), { mode: 0o644 });
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', `${LABEL}.service`]);
    const warn = lingerEnabled() ? null
      : `systemd --user services stop at logout. Run: loginctl enable-linger ${os.userInfo().username}`;
    return { ok: true, kind, path: p, warn };
  }

  // launchd: the plist inlines the credential, so it must not be world-readable.
  const env = parseEnvFile(envFile);
  fs.writeFileSync(p, launchdPlist({ node, shipJs, interval, env, logDir }), { mode: 0o600 });
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.shipper`]); // ignore if absent
  const r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, p], { encoding: 'utf-8' });
  if (r.status !== 0) return { ok: false, msg: (r.stderr || '').trim() || 'launchctl bootstrap failed', path: p };
  return { ok: true, kind, path: p, warn: null };
}

function uninstall() {
  const kind = platform();
  if (!kind) return { ok: false, msg: `no service integration for platform '${process.platform}'` };
  const p = unitPaths()[kind];
  if (kind === 'systemd') {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${LABEL}.service`]);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    spawnSync('systemctl', ['--user', 'daemon-reload']);
  } else {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/com.memhouse.shipper`]);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return { ok: true, kind, path: p };
}

function status() {
  const kind = platform();
  if (!kind) return { kind: null, installed: false, running: false };
  const p = unitPaths()[kind];
  const installed = fs.existsSync(p);
  let running = false;
  if (kind === 'systemd') {
    running = spawnSync('systemctl', ['--user', 'is-active', `${LABEL}.service`], { encoding: 'utf-8' })
      .stdout.trim() === 'active';
  } else {
    const r = spawnSync('launchctl', ['print', `gui/${process.getuid()}/com.memhouse.shipper`], { encoding: 'utf-8' });
    running = r.status === 0 && /state = running|state = waiting/.test(r.stdout || '');
  }
  return { kind, installed, running, path: p };
}

module.exports = { install, uninstall, status, platform };
