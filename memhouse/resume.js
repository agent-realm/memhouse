// Resume: hand the pilot back into a session memhouse only ever read.
//
// Nothing here needs a schema change. A stored session already carries everything a
// resume needs: `session_id` is canonical `<source>:<native-id>` (ship.js:575) and
// `folder` is the directory the session ran in. Resume is a read-time computation over
// two columns.
//
// Two rules, both learned the hard way in this repo:
//
//   1. PRINT the command, never run it. A wrong cwd or a stale id does not fail — it
//      starts a NEW session, and the transcript the pilot wanted is still lost while the
//      tool reports success. The pilot pastes it, sees what it does, and owns the result.
//
//   2. Never write a flag from memory. Round 10 exists because a field name was asserted
//      from a failed search rather than read from the source. Every entry below was read
//      out of that CLI's own `--help` on a machine where it is installed, and the date and
//      version are recorded with it. An editor whose flag has not been read that way is
//      ABSENT from this table — an absent entry prints an honest refusal, a guessed entry
//      prints a command that silently does the wrong thing.
//
// To add one: install the CLI, run `<cli> --help` (and `<cli> resume --help` if it is a
// subcommand), copy the exact syntax, and record what you read it from.

// Keyed by the string that is actually STORED in the `source` column, which is NOT the
// adapter's module `name`: editors/claude.js is `const name = 'claude'` and emits
// `source: 'claude-code'` on every chat it returns. This table was written against the
// module names first and would have refused to resume a single Claude Code session — 508 of
// them on the machine it was tested on. Read the values out of a real house
// (`SELECT DISTINCT source FROM sessions_<you>`), never off the adapter's name.
const RESUMERS = {
  // claude --help, 2026-08-12: "-r, --resume [value]  Resume a conversation by session ID"
  'claude-code': {
    cli: 'claude',
    argv: (id) => ['--resume', id],
    verified: '2026-08-12',
  },
  // codex resume --help, 2026-08-12: "Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]"
  // — positional, and "UUIDs take precedence if it parses".
  codex: {
    cli: 'codex',
    argv: (id) => ['resume', id],
    verified: '2026-08-12',
  },
  // opencode --help, 2026-08-12: "-s, --session  session id to continue  [string]"
  opencode: {
    cli: 'opencode',
    argv: (id) => ['--session', id],
    verified: '2026-08-12',
  },
  // NOT here, deliberately, and each for a different reason:
  //
  //   goose, gemini-cli, cursor-agent — plausibly resumable, but not installed on the
  //   machine this table was written on, so the flag could only have been guessed. Install
  //   one, read its --help, add it.
  //
  //   everything in GUI_ONLY — no CLI entry point takes a session id there. Opening the
  //   folder is not resuming the session and must not be dressed up as it.
};

// Surfaces with no CLI to resume into AT ALL, separated from "the flag has not been read
// yet" so the refusal can say which of the two it is — the same reason `discover` separates
// a skipped adapter from an editor you do not have.
//
// Stored `source` values again, and two corrections already: `copilot.js` emits
// `copilot-cli` and IS a command line, so it does not belong here; and windsurf never emits
// 'windsurf' at all — it emits its VARIANTS id, `devin` or `devin-next` — so the name this
// list first carried matched nothing and every Devin session fell through to the wrong
// refusal.
//
// Membership means: no command line takes a session id here, so no amount of checking will
// produce one. Anything merely UNCHECKED belongs in UNVERIFIED — asserting "there is
// nothing to resume into" about a tool nobody has looked at is the same invented fact as
// guessing a flag.
const GUI_ONLY = new Set([
  'cursor', 'vscode', 'zed', 'kiro', 'copilot-jetbrains', 'antigravity',
  'devin', 'devin-next',
]);

// A plausible CLI that nobody has verified. Listed explicitly instead of left to fall
// through a default, so the completeness test can prove every source the adapters can emit
// lands in exactly one bucket — which is what would have caught both corrections above
// before they shipped.
const UNVERIFIED = new Set([
  'goose', 'gemini-cli', 'cursor-agent', 'copilot-cli', 'codebuff', 'commandcode', 'gsd',
]);

// A session_id is `<source>:<native-id>`. Split on the FIRST colon only: several editors
// use colons inside their own ids, and slicing on the last one hands the CLI a truncated id
// that resolves to nothing.
function splitSessionId(sessionId) {
  const i = String(sessionId).indexOf(':');
  if (i <= 0) return null;
  return { source: sessionId.slice(0, i), nativeId: sessionId.slice(i + 1) };
}

// Shell-quote for the line we PRINT. This never feeds an exec — it is text a human pastes
// — but a session folder with a space in it must still paste correctly, and an id is
// server-supplied data that has no business being read as shell syntax.
function shq(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a stored session row into something the pilot can paste.
 *
 * @param {{session_id: string, source?: string, folder?: string, origin?: string}} row
 * @returns {{ok: boolean, source: string, nativeId: string|null, folder: string,
 *            command: string|null, reason: string|null}}
 */
function resumeFor(row) {
  const parts = splitSessionId(row.session_id);
  // `source` is its own column, but the id prefix is what the CLI half of the pair is keyed
  // on; prefer the column and fall back to the prefix so a row from an older house still
  // resolves.
  const source = row.source || (parts && parts.source) || '';
  const nativeId = parts ? parts.nativeId : null;
  const folder = row.folder || '';
  const base = { source, nativeId, folder, command: null, ok: false, reason: null };

  if (!nativeId) {
    return { ...base, reason: `'${row.session_id}' is not a canonical <source>:<id> session id` };
  }
  // Imported rows come from an older house, another product, or a machine that no longer
  // exists — the whole point of the `origin` guard the shipper carries. There is no local
  // session store behind them, so no resume command can be right, and this is checked
  // BEFORE the source table: 502 of the 1,304 sessions on the machine this was built on are
  // imported `claude-ai` rows, and a source-only check would have offered to resume them.
  if (row.origin && row.origin !== 'ship') {
    return {
      ...base,
      reason: `this session was imported (origin='${row.origin}'), not read from a local editor — there is nothing on this machine to resume into`,
    };
  }
  const r = RESUMERS[source];
  if (!r) {
    return {
      ...base,
      reason: GUI_ONLY.has(source)
        ? `${source} is a GUI editor — it has no CLI that takes a session id, so there is nothing to resume into`
        : `no verified resume command for ${source} — see memhouse/resume.js for how to add one`,
    };
  }
  const cmd = [r.cli, ...r.argv(nativeId)].map(shq).join(' ');
  // The cd is half the command. Claude Code and Codex both scope their session lists by
  // working directory, so the same id run from the wrong folder opens the picker or a new
  // session instead of the transcript that was asked for.
  return { ...base, ok: true, command: folder ? `cd ${shq(folder)} && ${cmd}` : cmd };
}

module.exports = { RESUMERS, GUI_ONLY, UNVERIFIED, resumeFor, splitSessionId };
