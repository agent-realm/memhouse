// A daemon that keeps executing the code it booted with.
//
// `npm i -g memhouse@latest` replaces the files under the global prefix and does not touch
// the running processes, so the shipper keeps parsing with the old adapters and the
// dashboard keeps serving the old bundle. Nothing reports it: `status` prints the version
// of the CLI you just typed, not the version the daemon is running. On macminim a shipper
// ran 1d16h out of a directory that had been MOVED — the fix was live, the machine was not.
//
// npm's own `postinstall` is the obvious hook and the wrong one. npm >= 12 blocks install
// scripts by default, so it would not run at all on a stock install — the same default
// that cost this product its SQLite binding until `node:sqlite` removed the need for one —
// and a package install that restarts a user's daemons is a surprise even when it works.
//
// So the daemon notices for itself. Once per loop pass it compares what is on disk against
// what it booted with, and when they differ it hands over:
//
//   supervised (systemd/launchd set MEMHOUSE_SUPERVISED=1) — exit 0 and let the supervisor
//     start a fresh process. Re-execing under a supervisor fights it: the unit's own
//     restart would then race the child we spawned.
//
//   unsupervised (`memhouse start` pidfiles) — re-exec ourselves detached, rewrite the
//     pidfile, exit. Nothing else would ever restart it, and exiting silently would stop
//     collecting memory, which is worse than running one pass of stale code.
//
// Guards, because a daemon that restarts itself wrongly is worse than one that is stale:
// a re-exec chain is counted in the environment and capped, and there is a floor on how
// often a restart may happen at all.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHAIN_VAR = 'MEMHOUSE_REEXEC_CHAIN';
const MAX_CHAIN = 3;
const MIN_INTERVAL_MS = 60_000;

function runDir() {
  const home = process.env.MEMHOUSE_HOME || path.join(require('os').homedir(), '.memhouse');
  return path.join(home, 'run');
}

// Read the version off DISK, never `require()`. require caches the first read for the
// lifetime of the process, so a required package.json reports the version this daemon
// booted with no matter how many times it is re-read — which is exactly the value we are
// trying to detect a change in.
function diskVersion(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version || null; }
  catch { return null; }
}

/**
 * What this process is running, captured at boot.
 * @param {string} entry absolute path of the daemon's own entry script
 * @param {string} [repoRoot] where package.json lives; defaults two levels up from the
 *   entry's directory, which is where both daemons sit (memhouse/<part>/<entry>.js).
 *   Pass it explicitly rather than relying on that depth if you move an entry.
 */
function snapshot(entry, repoRoot = path.join(path.dirname(entry), '..', '..')) {
  let real = null, mtimeMs = null;
  try { real = fs.realpathSync(entry); mtimeMs = fs.statSync(real).mtimeMs; } catch { /* reported as drift */ }
  return { entry, repoRoot, version: diskVersion(repoRoot), real, mtimeMs, at: Date.now() };
}

/**
 * Has the installation underneath us changed?
 * @returns {string|null} a human-readable reason, or null when nothing moved
 */
function driftReason(snap) {
  const now = diskVersion(snap.repoRoot);
  if (snap.version && now && now !== snap.version) return `version changed ${snap.version} → ${now}`;
  let real = null, mtimeMs = null;
  try { real = fs.realpathSync(snap.entry); mtimeMs = fs.statSync(real).mtimeMs; } catch { real = null; }
  // The entry is gone: the directory this daemon runs out of was deleted, moved, or
  // replaced. Reported, but NOT restartable — see maybeRestart, which refuses to re-exec a
  // path that no longer resolves.
  if (!real) return 'the directory this daemon runs from no longer exists';
  if (snap.real && real !== snap.real) return `entry moved ${snap.real} → ${real}`;
  // mtime alone, with the version unchanged, is a checkout being rebuilt or edited in
  // place. Worth acting on for the same reason the version is: the running process is not
  // the code on disk.
  if (snap.mtimeMs && mtimeMs && mtimeMs !== snap.mtimeMs) return 'the entry script changed on disk';
  return null;
}

function chainCount() {
  const n = Number(process.env[CHAIN_VAR]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Only ever rewrite a pidfile that names US. A daemon started by hand has no pidfile, and a
// pidfile naming some other process belongs to that process — overwriting it would point
// `memhouse stop` at ours and leave theirs running forever.
function adoptPidfile(name, newPid, log) {
  const file = path.join(runDir(), name + '.pid');
  try {
    if (Number(fs.readFileSync(file, 'utf-8').trim()) !== process.pid) return;
    fs.writeFileSync(file, String(newPid));
  } catch { log(`[memhouse] could not update ${file} — 'memhouse stop' may not find the new process`); }
}

/**
 * Act on drift. Returns false when nothing was done, and does not return at all when it
 * hands over (the process exits).
 *
 * @param {object} o
 * @param {ReturnType<snapshot>} o.snap  what we booted with
 * @param {string} o.name                daemon name, matching its pidfile ('shipper' | 'dashboard')
 * @param {(s: string) => void} [o.log]
 */
function maybeRestart({ snap, name, log = console.error }) {
  const reason = driftReason(snap);
  if (!reason) return false;
  if (Date.now() - snap.at < MIN_INTERVAL_MS) return false;

  const supervised = process.env.MEMHOUSE_SUPERVISED === '1';
  log(`[memhouse] ${reason} — this ${name} is running code that is no longer installed`);

  if (supervised) {
    log('[memhouse] exiting so the service manager starts the new version');
    process.exit(0);
  }
  // An entry that does not resolve cannot be re-executed, and there is no supervisor to
  // resolve a fresh one. Keep shipping with what is loaded and say so every pass: a stale
  // daemon still collects sessions, a dead one collects nothing.
  let real = null;
  try { real = fs.realpathSync(snap.entry); } catch { /* handled next */ }
  if (!real) {
    log(`[memhouse] cannot restart — nothing to exec. Fix it with: memhouse stop && memhouse start`);
    return false;
  }
  if (chainCount() >= MAX_CHAIN) {
    log(`[memhouse] already restarted ${MAX_CHAIN} times in this chain — not restarting again. Fix it with: memhouse stop && memhouse start`);
    return false;
  }

  const child = spawn(process.execPath, [real, ...process.argv.slice(2)], {
    env: { ...process.env, [CHAIN_VAR]: String(chainCount() + 1) },
    detached: true,
    // The daemon's stdout/stderr are already the log file `memhouse start` opened, and a
    // detached child inherits those descriptors — so the new process keeps writing to the
    // same log with no second file to find.
    stdio: 'inherit',
  });
  child.unref();
  adoptPidfile(name, child.pid, log);
  log(`[memhouse] restarted as pid ${child.pid}`);
  process.exit(0);
}

module.exports = { snapshot, driftReason, maybeRestart, CHAIN_VAR, MAX_CHAIN, MIN_INTERVAL_MS };
