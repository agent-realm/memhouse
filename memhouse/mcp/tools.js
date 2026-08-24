// tools.js — the six MCP tools, with zero protocol knowledge.
//
// Plain async handlers over server/queries.js and resume.js: arguments in, JSON
// out. rpc.js owns everything MCP-shaped (framing, _meta, resultType, errors), so
// this file is testable with no transport, no client, and no spec in scope — and a
// protocol revision or SDK swap never touches it.
//
// Config: the CLI (`memhouse mcp`) resolves the house exactly like every other
// command and stamps MEMHOUSE_* into process.env BEFORE this file's lazy require
// of queries.js runs. When nothing is stated, no env is stamped, and every call
// refuses with the standard no-house message — as a TOOL RESULT (isError), not a
// protocol error. A protocol error would kill discovery, and a client that cannot
// even list the tools shows the user nothing but "server failed".

const os = require('os');
const path = require('path');
const guard = require('../server/sql-guard');

const HOME_DIR = process.env.MEMHOUSE_HOME || path.join(os.homedir(), '.memhouse');
const ENV_FILE = path.join(HOME_DIR, 'env');

function configured() {
  return Boolean(process.env.MEMHOUSE_URL || process.env.MEMHOUSE_USER);
}

class RefusalError extends Error {}

// Same facts as the CLI's requireConfig(), phrased for the model that will read it.
function requireHouse() {
  if (configured()) return;
  throw new RefusalError(
    'no house configured, so this tool has nothing to talk to.\n' +
    `Nothing was read from ${ENV_FILE.replace(os.homedir(), '~')} and no MEMHOUSE_URL/MEMHOUSE_USER is set. ` +
    'Rather than guess http://localhost:8123 — which on many machines is a real house belonging to someone else — this stops here.\n' +
    'Fix: run `memhouse install --url … --user … --password …`, or `memhouse onboard`, ' +
    'or start this MCP server with MEMHOUSE_URL/MEMHOUSE_USER/MEMHOUSE_PASSWORD set in its environment.');
}

// queries.js snapshots MEMHOUSE_* at require time — load it only after the
// no-house check, so an unconfigured server never builds a client at all.
let _qy = null;
function qy() { return (_qy ||= require('../server/queries')); }

// ── the tools, in the order tools/list serves them (deterministic — the spec asks
// for a stable order so clients and prompt caches can rely on it) ──────────────

const TOOLS = [
  {
    name: 'search',
    description:
      'Search this house\'s agent conversation memory (all editors, all members). ' +
      'Returns a compact index — session_id, user_id, editor, project, date, hit count, a 150-char snippet, ' +
      'and est_expand_tokens: the approximate token cost of fetching that whole session. ' +
      'Never returns transcript text; pick the sessions worth est_expand_tokens and fetch those with get_session.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'substring to search for (case-insensitive)' },
        limit: { type: 'integer', description: 'max sessions to return (default 10, max 100)' },
      },
      required: ['q'],
    },
    async handler(args) {
      requireHouse();
      const rows = await qy().searchSessions(args.q, args.limit);
      return { matches: rows.length, results: rows };
    },
  },
  {
    // Named for the `/mem:sessions` skill, not for the query it runs: a person who learns
    // this house through one surface should not have to relearn the vocabulary on another.
    name: 'sessions',
    description:
      'Sessions nearest a moment in time — an ISO date/datetime, or another session\'s last activity ' +
      '(pass session_id). With neither, the most recent sessions. Chronological context for a search hit: ' +
      'what else was being worked on around then.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'anchor date or datetime, e.g. 2026-08-12 or 2026-08-12 21:00' },
        session_id: { type: 'string', description: 'anchor on this session\'s last activity instead of a date' },
        limit: { type: 'integer', description: 'max sessions (default 20, max 100)' },
      },
    },
    async handler(args) {
      requireHouse();
      return qy().timelineSessions(args);
    },
  },
  {
    name: 'get_session',
    description:
      'Full transcript (or a seq-range slice) of one stored session. The only tool that returns message text — ' +
      'check est_expand_tokens from search first, and slice with seq_from/seq_to when the session is large. ' +
      'In a shared house the same session_id can be held by more than one member; pass user_id to pick one ' +
      '(with several holders and no user_id, the holder list comes back instead of a guess).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'canonical id from search, e.g. claude-code:<uuid>' },
        user_id: { type: 'string', description: 'which member\'s copy, when several hold this session' },
        seq_from: { type: 'integer', description: 'first message seq to include (default 0)' },
        seq_to: { type: 'integer', description: 'last message seq to include (default: end)' },
        limit: { type: 'integer', description: 'max messages per call (default 500, max 1000)' },
      },
      required: ['session_id'],
    },
    async handler(args) {
      requireHouse();
      return qy().getSessionSlice(args);
    },
  },
  {
    // `/mem:status` on the plugin surface. Same answer, same name.
    name: 'status',
    description:
      'The house at a glance: session and message counts per editor, per member, per machine, ' +
      'with the freshest activity of each. Use it to see whose memory is here and how current it is.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      requireHouse();
      return qy().statsHouse();
    },
  },
  {
    // `/mem:users`. The people questions a client would otherwise have to write SQL for —
    // and get wrong, because the honest answer depends on which sections the credential
    // was actually allowed to read.
    name: 'users',
    description:
      'The people around this house: which members and machines write INTO it, which other houses this ' +
      'credential can read (each one shared with you — query it as <house>.messages), and who has been ' +
      'given a read window into this one. Best-effort by design: a section this credential may not read ' +
      'comes back null with its reason in `unavailable`. Never read an absent section as an absence — ' +
      'shared_with drawn from the share ledger cannot see a grant an admin issued by hand, and says so ' +
      'in shares_source.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      requireHouse();
      return qy().usersHouse();
    },
  },
  {
    name: 'resume_command',
    description:
      'The paste-ready shell command that reopens a stored session in its own editor (claude --resume, ' +
      'codex resume, …), or an honest refusal when none can be right — imported sessions, GUI-only editors, ' +
      'and editors whose resume flag has never been verified are refused, not guessed. ' +
      'The command is returned for the pilot to run; it is never executed here.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'canonical id from search' },
        user_id: { type: 'string', description: 'which member\'s copy, when several hold this session' },
      },
      required: ['session_id'],
    },
    async handler(args) {
      requireHouse();
      const row = await qy().sessionRowFor(args.session_id, args.user_id);
      if (!row) return { ok: false, reason: `no stored session with id '${args.session_id}'` };
      const { resumeFor } = require('../resume');
      return resumeFor(row);
    },
  },
  {
    name: 'sql',
    description:
      'Free-form read-only SQL over the house (ClickHouse dialect). Runs under the credential this server ' +
      'was configured with — writes, and anything that credential may not read, are refused by ClickHouse ' +
      'itself and its refusal is returned verbatim as the answer. One rule is memhouse\'s own: table ' +
      'functions that reach off this server (remote, remoteSecure, cluster, url, s3, mysql, …) are refused ' +
      'here whatever the credential is granted; numbers, values, null, generateSeries and format are fine. ' +
      'readonly is pinned per request; results are capped at 10000 rows / 64MB / 30s. ' +
      'The main tables are sessions, messages, and tool_calls. Prefer search/get_session for transcript ' +
      'work — this tool is for aggregations they cannot express.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'one read-only SQL statement' },
      },
      required: ['query'],
    },
    async handler(args) {
      const sql = String(args.query);
      // Checked BEFORE requireHouse(): a query that reaches off this server is refused
      // whether or not a house is configured, and the caller gets the reason rather than
      // "no house configured" standing in front of it.
      // The one thing ClickHouse no longer refuses on its own. A member holds
      // `REMOTE ON *.*` since relocate needed it, so `remote()` runs under this
      // tool's pinned `readonly` — it returns rows, an unreachable host times out
      // instead of being denied, and the password argument folds a subquery, which
      // is a way out for anything this credential can read. The model writing this
      // SQL is reading transcripts it did not author, so "the grants contain it" is
      // no longer true and memhouse has to say so itself. Refused as a tool result,
      // with the reason: a model that knows why picks a different query.
      const fn = guard.disallowedTableFunction(sql);
      if (fn) {
        throw new RefusalError(
          `table function ${fn}() is refused here — this tool reads this ClickHouse and does not reach out of it. ` +
          'Functions that dial out (remote, remoteSecure, cluster, url, s3, mysql, …) are refused whatever the ' +
          'credential is granted; numbers, values, null, generateSeries and format are available. ' +
          "Query the house's own tables — sessions, messages, tool_calls — instead.");
      }
      requireHouse();
      return qy().readonlySql(sql);
    },
  },
];

module.exports = { TOOLS, RefusalError, configured };
