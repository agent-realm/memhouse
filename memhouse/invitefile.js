// An invite file found where the invitee is standing.
//
// The guide says "from the directory holding the file, run memhouse install --env <file>".
// A person who just downloaded `invite-alice.env` and typed `memhouse` should not be shown
// the help screen; they should be asked whether to join. This module finds candidate files
// and reads what they promise; the CLI decides whether to ask, and install does the work.
// Nothing here prints a value from the file — the URL, user and database are safe to show,
// the password never is.

const fs = require('fs');
const path = require('path');
const envfile = require('./envfile');

const REQUIRED = ['MEMHOUSE_URL', 'MEMHOUSE_USER', 'MEMHOUSE_PASSWORD', 'MEMHOUSE_DB'];

/** `invite-<name>.env` files in the given directories, first directory first. */
function findInvites(dirs) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.sort()) if (/^invite-[A-Za-z0-9_]+\.env$/.test(n)) out.push({ file: path.join(dir, n), dir });
  }
  return out;
}

/** What the file promises, without the secret. */
function describeInvite(text) {
  const parsed = envfile.parse(String(text || ''));
  const missing = REQUIRED.filter((k) => !parsed[k]);
  return {
    user: parsed.MEMHOUSE_USER || null, url: parsed.MEMHOUSE_URL || null, db: parsed.MEMHOUSE_DB || null,
    channel: parsed.MEMHOUSE_CHANNEL || null, isInvite: parsed.MEMHOUSE_INVITE === '1',
    complete: missing.length === 0, missing,
  };
}

module.exports = { findInvites, describeInvite, REQUIRED };
