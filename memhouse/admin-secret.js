// Where an ADMIN password comes from — and why the command line is the last place.
//
// A password passed as `--admin-password <p>` is in the process list (`ps`) for as long
// as the command runs and in shell history unless the caller remembered a leading space.
// The only scriptable admin path used to demand exactly that: `--admin-user` as a flag
// turned off every other source, so an agent or CI job that held the password in an
// environment variable (or in a secret store, via `with-secret`) still had to put it on
// argv. Found by O's sandbox rehearsal (finding 6).
//
// Order, first answer wins:
//   1. --admin-password-file <path>  a file holding the password (trailing newline dropped)
//      --admin-password-file -       read it from stdin   (printf '%s' "$P" | memhouse …)
//   2. --admin-password <p>          still accepted, with a warning — never required
//   3. MEMHOUSE_ADMIN_PASSWORD       the environment; `with-secret` lends it to one command
//   4. the stored credential         only when it belongs to the SAME admin user
// Nothing here prompts: the caller decides whether a TTY prompt is the next step.
//
// Pure apart from the one file/stdin read, which is injectable, so it is unit tested.

const fs = require('fs');

// Strip exactly one trailing newline: `echo secret > f` writes one, and a password that
// legitimately ends in whitespace must survive.
function stripOneNewline(s) {
  return String(s).replace(/\r?\n$/, '');
}

function readSecretFile(spec, { readFile = fs.readFileSync, stdinIsTTY = process.stdin.isTTY } = {}) {
  if (spec === '-') {
    if (stdinIsTTY) throw new Error('--admin-password-file - reads the password from stdin, but stdin is a terminal — pipe it in, or leave the flag off to be prompted');
    return stripOneNewline(readFile(0, 'utf-8'));
  }
  let text;
  try { text = readFile(spec, 'utf-8'); } catch (e) { throw new Error(`--admin-password-file ${spec}: ${e.code === 'ENOENT' ? 'no such file' : e.message.split('\n')[0]}`); }
  return stripOneNewline(text);
}

/**
 * @param {object} o
 * @param {string} o.adminUser      the admin user this password is for
 * @param {object} o.flags          parsed CLI flags
 * @param {object} [o.env]          process.env (injectable)
 * @param {object} [o.stored]       { user, password } this install keeps, if any
 * @param {object} [o.io]           { readFile, stdinIsTTY } for tests
 * @returns {{ password: string|undefined, source: 'file'|'stdin'|'flag'|'env'|'stored'|null }}
 */
function resolveAdminPassword({ adminUser, flags = {}, env = process.env, stored = null, io = {} }) {
  const fileFlag = flags['admin-password-file'];
  const argvFlag = flags['admin-password'];
  if (fileFlag !== undefined && argvFlag !== undefined) {
    throw new Error('give the admin password one way: --admin-password-file or --admin-password, not both');
  }
  if (fileFlag !== undefined) {
    if (fileFlag === true || fileFlag === '') throw new Error('--admin-password-file needs a path, or - for stdin');
    const password = readSecretFile(String(fileFlag), io);
    return { password, source: fileFlag === '-' ? 'stdin' : 'file' };
  }
  if (argvFlag !== undefined && argvFlag !== true) return { password: String(argvFlag), source: 'flag' };
  if (env && typeof env.MEMHOUSE_ADMIN_PASSWORD === 'string' && env.MEMHOUSE_ADMIN_PASSWORD !== '') {
    return { password: env.MEMHOUSE_ADMIN_PASSWORD, source: 'env' };
  }
  if (stored && stored.user && stored.password && stored.user === adminUser) {
    return { password: stored.password, source: 'stored' };
  }
  return { password: undefined, source: null };
}

// One line for a caller that took the password off argv anyway.
const ARGV_WARNING = '--admin-password on the command line is visible in `ps` and shell history, and is deprecated: it is removed in 0.19.0. Use MEMHOUSE_ADMIN_PASSWORD (with-secret) or --admin-password-file -';

// What to tell a caller with no TTY and no password from any source.
function missingAdminPasswordHelp(adminUser) {
  return [
    `no password for admin '${adminUser}', and no TTY to prompt on. Give it without putting it on the command line:`,
    `     with-secret MEMHOUSE_ADMIN_PASSWORD=<reference> -- memhouse …`,
    `     printf '%s' "$PASSWORD" | memhouse … --admin-password-file -`,
    `     memhouse … --admin-password-file <file, mode 600>`,
  ];
}

module.exports = { resolveAdminPassword, readSecretFile, stripOneNewline, ARGV_WARNING, missingAdminPasswordHelp };
