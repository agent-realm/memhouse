// Which options each command takes, and what to say when one is not among them.
//
// Anything `--like-this` used to be accepted and ignored. That is quiet in the good case
// and dangerous in the bad one: `--dryrun` for `--dry-run` does not warn, it RUNS the
// migration; `--adopt` on a build that predates the guard is swallowed and the invite
// proceeds into somebody else's house. A flag the program does not know is a sentence
// the user believes they said and the program never heard.
//
// The tables live here rather than beside the parser so a test can hold them against the
// flags the CLI actually reads — a flag added to one and not the other fails the suite
// instead of being discovered by whoever typed it.

const GLOBAL_FLAGS = ['json', 'yes', 'help', 'version'];

const COMMAND_FLAGS = {
  null: [], help: [], version: [],
  whoami: ['admin'],
  share: ['only', 'revoke', 'list'],
  discover: [], stats: [], stop: [], doctor: [], 'sessions-query': [],
  status: [], start: [],
  onboard: ['url', 'user', 'password', 'db', 'port', 'no-ship', 'target', 'house-port', 'tag', 'local'],
  install: ['url', 'user', 'password', 'db', 'port', 'no-ship', 'env', 'print-sql', 'member',
    'member-password', 'admin-user', 'admin-password', 'ensure-schema', 'rotate-password', 'force'],
  setup: ['url', 'user', 'password', 'db', 'port'],
  ship: ['full', 'loop', 'ensure-schema'],
  search: ['limit'],
  resume: [],
  update: ['check', 'migrate', 'no-install'],
  reset: ['all-origins'],
  invite: ['url', 'db', 'out', 'admin-user', 'admin-password', 'adopt', 'print-sql',
    'allow-local', 'member-password'],
  passwd: ['password', 'admin-user', 'admin-password', 'print-sql', 'member'],
  nightly: ['out'],
  migrate: ['dry-run'], 'migrate-rooms': ['dry-run'],
  relocate: ['to', 'to-user', 'to-password', 'to-db', 'from-native-host', 'from-native-port',
    'insecure-native', 'keep-shipper', 'dry-run'],
  deploy: ['local', 'down', 'house-port', 'port', 'tag'],
  service: ['interval'],
  uninstall: ['credentials', 'full-removal'],
  plugins: ['target'],
  prompt: ['install'],
};

/** Levenshtein, small and local — this is the only caller. */
function editDistance(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
}

/** The flag a typo most likely meant, or null when nothing is close enough to guess. */
function suggestFlag(bad, allowed) {
  let best = null; let bd = Infinity;
  for (const c of allowed) { const d = editDistance(bad, c); if (d < bd) { bd = d; best = c; } }
  return bd <= Math.max(2, Math.floor(bad.length / 3)) ? best : null;
}

/** Every option this command does not take. Unknown COMMANDS return [] — dispatch owns that. */
function unknownFlags(cmd, flags) {
  const known = COMMAND_FLAGS[cmd === null || cmd === undefined ? 'null' : cmd];
  if (known === undefined) return [];
  const allowed = allowedFlags(cmd);
  return Object.keys(flags).filter((f) => !allowed.has(f));
}

/** The full accepted set for a command, globals included. */
function allowedFlags(cmd) {
  const known = COMMAND_FLAGS[cmd === null || cmd === undefined ? 'null' : cmd] || [];
  return new Set([...GLOBAL_FLAGS, ...known]);
}

module.exports = { GLOBAL_FLAGS, COMMAND_FLAGS, unknownFlags, allowedFlags, suggestFlag, editDistance };
