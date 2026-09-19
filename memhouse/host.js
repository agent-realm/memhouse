// Which machine shipped this row.
//
// All of one member's machines ship into that member's rooms — that is the point of the
// shared-house layout — and the `host` column is the only thing telling them apart. So the
// value has to be BOTH unique per machine and stable across that machine's lifetime.
//
// It used to be derived, `sha256(hostname|platform|arch)`, and that fails in both
// directions:
//
//   * Two machines collide. A pilot with two MacBooks that both answer to
//     `MacBook-Pro` on the same darwin/arm64 produce the SAME id — their sessions merge
//     into one apparent host and neither can be told from the other. Default hostnames
//     are exactly the case where a person owns several.
//   * One machine splits. Rename the box and every row shipped afterwards lands under a
//     new host, so the machine's own history appears to end and a stranger's to begin.
//
// A random fingerprint, written once and kept, fixes both: nothing derives it, so nothing
// can collide with it, and nothing about the machine changing can move it.
//
// It lives in MEMHOUSE_HOME and is deliberately NOT removed by a plain `memhouse
// uninstall` — reinstalling on the same machine should continue that machine's history,
// not start a second one beside it. `uninstall --full-removal` drops it, and then the
// machine genuinely is a new host next time; that is the honest meaning of full removal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE = 'host.json';

function homeDir() {
  return process.env.MEMHOUSE_HOME || path.join(os.homedir(), '.memhouse');
}

function filePath(home = homeDir()) {
  return path.join(home, FILE);
}

// `<short-hostname>-<8 hex>`: the same SHAPE the derived id had, so dashboards and
// existing queries read the same, but the hex half now comes from the stored fingerprint
// rather than from a hash of facts that can collide or change.
function idFrom(hostname, fingerprint) {
  const short = (hostname || 'host').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '') || 'host';
  return `${short}-${fingerprint.slice(0, 8)}`;
}

function read(home = homeDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(home), 'utf-8'));
    if (raw && typeof raw.fingerprint === 'string' && raw.fingerprint.length >= 8) return raw;
  } catch { /* absent or unreadable — treated as "not yet created" */ }
  return null;
}

/**
 * A fingerprint of THIS MACHINE, not of this install.
 *
 * It used to be `randomBytes(16)`, which lives only in host.json — so wiping MEMHOUSE_HOME
 * (`uninstall --full-removal`, a reset, a new laptop image) made the same physical machine
 * come back as a stranger. One MacBook read as three writers in the fleet list, each
 * holding a slice of the same machine's history.
 *
 * Now it is derived from a stable per-machine id — IOPlatformUUID on macOS,
 * /etc/machine-id (or the D-Bus one) on Linux, MachineGuid on Windows — hashed with a
 * fixed salt so the raw hardware id never leaves the machine and cannot be recovered from
 * a row. Same machine, same fingerprint, reinstall after reinstall. Where no such id can
 * be read, it falls back to random: an identity that is merely unstable is far better than
 * one that collides, and the fallback is recorded so callers can say which happened.
 *
 * @returns {string} 32 hex characters
 */
function machineFingerprint(raw = stableMachineId()) {
  const SALT = 'memhouse/host/v1'; // versioned: changing it re-identifies every machine
  return raw
    ? crypto.createHash('sha256').update(`${SALT}:${raw}`).digest('hex').slice(0, 32)
    : crypto.randomBytes(16).toString('hex');
}

/** The OS's own machine id, or null when it cannot be read. Never stored, never shipped. */
function stableMachineId() {
  const run = (cmd, args) => {
    try {
      const r = require('child_process').execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
      return String(r || '').trim() || null;
    } catch { return null; }
  };
  try {
    if (process.platform === 'darwin') {
      const out = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const m = out && /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      return m ? m[1] : null;
    }
    if (process.platform === 'linux') {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { const v = fs.readFileSync(f, 'utf-8').trim(); if (v) return v; } catch { /* next */ }
      }
      return null;
    }
    if (process.platform === 'win32') {
      const out = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
      const m = out && /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out);
      return m ? m[1] : null;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * The identity of this machine, creating it on first use.
 *
 * Every entry point calls this rather than only `install`, because a checkout can ship
 * without ever running install — and a shipper that could not name its host would either
 * refuse to run or invent a different name each pass.
 *
 * @param {string} [home]
 * @returns {{id: string, fingerprint: string, hostname: string, created: string,
 *            renamed: boolean, platform: string, arch: string}}
 */
function identity(home = homeDir()) {
  const hostname = os.hostname();
  let rec = read(home);
  if (!rec) {
    rec = {
      fingerprint: machineFingerprint(),
      hostname,
      platform: os.platform(),
      arch: os.arch(),
      // Stamped once. Never rewritten, so it says when this machine joined, not when the
      // file was last touched.
      created: new Date().toISOString(),
    };
    rec.id = idFrom(hostname, rec.fingerprint);
    try {
      fs.mkdirSync(home, { recursive: true });
      // Written with the same 0600 the credential gets. It is not a secret, but it is an
      // identity: anything that can read it can impersonate this host's rows.
      fs.writeFileSync(filePath(home), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    } catch { /* read-only home: fall through with an in-memory identity for this run */ }
  }
  // The id is frozen at creation, INCLUDING the hostname baked into it. A rename must not
  // move the id — that is the split this exists to prevent — so the current hostname is
  // reported alongside instead, and `renamed` lets callers say so out loud rather than
  // printing a name the machine no longer answers to and leaving the reader to wonder.
  return {
    ...rec,
    id: rec.id || idFrom(rec.hostname, rec.fingerprint),
    hostname: rec.hostname,
    current_hostname: hostname,
    renamed: rec.hostname !== hostname,
  };
}

module.exports = { identity, read, filePath, idFrom, machineFingerprint, stableMachineId, FILE };
