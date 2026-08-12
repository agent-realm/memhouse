// Which machine shipped this row.
//
// All of one member's machines ship into that member's rooms — that is the point of the
// per-member layout — and the `host` column is the only thing telling them apart. So the
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
      fingerprint: crypto.randomBytes(16).toString('hex'),
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

module.exports = { identity, read, filePath, idFrom, FILE };
