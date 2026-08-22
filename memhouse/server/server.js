// memhouse server — the dashboard/API entrypoint.
//
// Speaks the agentlytics REST contract (same routes, same response shapes) over the
// memhouse typed schema, so the UNMODIFIED agentlytics React SPA is the dashboard:
// queries.js computes every response; this file is routing + config + stubs. Serves
// the built SPA from the repo root's public/.
//
//   node memhouse/server/server.js        (env: MEMHOUSE_* per DESIGN.md; port 4640)

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qy = require('./queries');
const guard = require('./sql-guard');

const PORT = parseInt(process.env.MEMHOUSE_PORT || '4640', 10);
// Localhost by default: the dashboard exposes full transcripts and a SQL console
// with no auth. Remote access is an explicit opt-in (MEMHOUSE_HOST=0.0.0.0).
const HOST = process.env.MEMHOUSE_HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// MEMHOUSE_HOME, like every other component. childEnv() already passes it to this child;
// this was the one place that ignored it and wrote to the real home instead. Anyone
// running a second house under MEMHOUSE_HOME — the documented way to test, and what every
// acceptance run is told to do — hid a project in their throwaway dashboard and had it
// written into the PILOT'S ~/.memhouse/config.json.
const CONFIG_PATH = path.join(process.env.MEMHOUSE_HOME || path.join(os.homedir(), '.memhouse'), 'config.json');

const app = express();
app.use(express.json());
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}
function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
// Both keys. `hiddenFolders` was accepted by PUT /api/config, validated, written to disk
// — and never read, so setting it changed nothing and said nothing.
const hiddenFolders = () => [...(readConfig().hiddenProjects || []), ...(readConfig().hiddenFolders || [])] || [];

function parseDateOpts(query) {
  const opts = {};
  if (query.dateFrom) opts.dateFrom = parseInt(query.dateFrom) || null;
  if (query.dateTo) opts.dateTo = parseInt(query.dateTo) || null;
  return opts;
}

// Route helper: async handler with the uniform 500 shape.
const route = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { res.status(500).json({ error: err.message }); }
};

app.get('/api/ping', (req, res) => res.json({ app: 'agentlytics', pid: process.pid }));
app.get('/api/mode', (req, res) => res.json({ mode: 'local' }));

app.get('/api/overview', route(async (req, res) => {
  res.json(await qy.getOverview({ editor: req.query.editor || null, ...parseDateOpts(req.query), hiddenFolders: hiddenFolders() }));
}));

app.get('/api/daily-activity', route(async (req, res) => {
  res.json(await qy.getDailyActivity({ editor: req.query.editor || null, ...parseDateOpts(req.query), hiddenFolders: hiddenFolders() }));
}));

app.get('/api/dashboard-stats', route(async (req, res) => {
  res.json(await qy.getDashboardStats({ editor: req.query.editor || null, ...parseDateOpts(req.query), hiddenFolders: hiddenFolders() }));
}));

app.get('/api/chats', route(async (req, res) => {
  const opts = {
    editor: req.query.editor || null,
    folder: req.query.folder || null,
    named: req.query.named !== 'false',
    // Clamped, not passed through. `offset=-5` reached ClickHouse as a UInt64 parameter
    // and came back as HTTP 500 carrying "Value -5 cannot be parsed as UInt64 … only 0 of
    // 2 bytes was parsed" — a server error and a database internal for a client mistake.
    // `limit=abc` was silently ignored and `limit=99999999999999999999` returned everything.
    limit: clampInt(req.query.limit, 200, 1, 5000),
    offset: clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    ...parseDateOpts(req.query),
    hiddenFolders: hiddenFolders(),
  };
  const [total, chats] = await Promise.all([qy.countChats(opts), qy.getChats(opts)]);
  res.json({ total, chats });
}));

app.get('/api/chats/:id', route(async (req, res) => {
  const result = await qy.getChat(req.params.id);
  if (!result) return res.status(404).json({ error: 'Chat not found' });
  res.json(result);
}));

app.get('/api/chats/:id/markdown', route(async (req, res) => {
  const result = await qy.getChat(req.params.id);
  if (!result) return res.status(404).json({ error: 'Chat not found' });
  const lines = [];
  const title = result.name || 'Untitled Session';
  lines.push(`# ${title}\n`);
  const meta = [];
  if (result.source) meta.push(`**Editor:** ${result.source}`);
  if (result.mode) meta.push(`**Mode:** ${result.mode}`);
  if (result.folder) meta.push(`**Project:** ${result.folder}`);
  if (result.createdAt) meta.push(`**Created:** ${new Date(result.createdAt).toISOString()}`);
  if (result.lastUpdatedAt) meta.push(`**Updated:** ${new Date(result.lastUpdatedAt).toISOString()}`);
  if (result.stats) {
    meta.push(`**Messages:** ${result.stats.totalMessages}`);
    if (result.stats.totalInputTokens) meta.push(`**Input Tokens:** ${result.stats.totalInputTokens}`);
    if (result.stats.totalOutputTokens) meta.push(`**Output Tokens:** ${result.stats.totalOutputTokens}`);
    const models = [...new Set(result.stats.models || [])];
    if (models.length > 0) meta.push(`**Models:** ${models.join(', ')}`);
  }
  if (meta.length > 0) lines.push(meta.join('  \n') + '\n');
  lines.push('---\n');
  for (const msg of result.messages) {
    const label = msg.role === 'user' ? '## User' : msg.role === 'assistant' ? '## Assistant' : `## ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}`;
    const modelTag = msg.model ? ` *(${msg.model})*` : '';
    lines.push(`${label}${modelTag}\n`);
    lines.push(msg.content + '\n');
  }
  const filename = title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80) + '.md';
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
}));

app.get('/api/projects', route(async (req, res) => {
  res.json(await qy.getProjects({ ...parseDateOpts(req.query), hiddenFolders: hiddenFolders() }));
}));

app.get('/api/all-projects', route(async (req, res) => {
  res.json(await qy.getProjects({ ...parseDateOpts(req.query), includeHidden: true }));
}));

app.get('/api/deep-analytics', route(async (req, res) => {
  res.json(await qy.getDeepAnalytics({
    editor: req.query.editor || null,
    folder: req.query.folder || null,
    limit: clampInt(req.query.limit, 500, 1, 5000),
    ...parseDateOpts(req.query),
    hiddenFolders: hiddenFolders(),
  }));
}));

app.get('/api/costs', route(async (req, res) => {
  res.json(await qy.estimateCosts({
    editor: req.query.editor || null,
    folder: req.query.folder || null,
    chatId: req.query.chatId || null,
    ...parseDateOpts(req.query),
    hiddenFolders: hiddenFolders(),
  }));
}));

app.get('/api/cost-analytics', route(async (req, res) => {
  res.json(await qy.getCostAnalytics({ editor: req.query.editor || null, ...parseDateOpts(req.query), hiddenFolders: hiddenFolders() }));
}));

app.get('/api/tool-calls', route(async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'name query param required' });
  // Same filter set as the analytics the drill-down is opened from.
  res.json(await qy.getToolCalls(name, {
    limit: clampInt(req.query.limit, 200, 1, 1000),
    folder: req.query.folder || null,
    editor: req.query.editor || null,
    ...parseDateOpts(req.query),
    hiddenFolders: hiddenFolders(),
  }));
}));

function clampInt(v, dflt, min, max) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// The databases that actually exist on this server, refreshed lazily. Comparing against
// real names keeps `alias.column` — the common case — from being refused, while still
// catching a genuine cross-database read.
let KNOWN_DBS = new Set(['system']);
let knownDbsAt = 0;
async function refreshKnownDbs() {
  if (Date.now() - knownDbsAt < 60000) return;
  try {
    const rows = await qy.rawQueryUnguarded('SELECT name FROM system.databases');
    KNOWN_DBS = new Set(rows.map((r) => String(r.name).toLowerCase()));
    KNOWN_DBS.add('system');
    knownDbsAt = Date.now();
  } catch { /* keep whatever we had */ }
}

app.post('/api/query', route(async (req, res) => {
  await refreshKnownDbs();
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql string required' });

  // The construct-aware reader that used to be inline here now lives in `sql-guard.js`,
  // shared with the MCP `sql` tool: a model writes the SQL on both surfaces, and every
  // member now holds `REMOTE ON *.*` (relocate needs it), so the dial-out refusal is no
  // longer something ClickHouse issues on its own. Same normalisation, same allowlist,
  // same four paid-for bypasses — read that file's comments before touching either.
  //
  // What stays HERE is this endpoint's own policy: read shapes only, and this house's
  // database only. The MCP tool deliberately keeps neither — reading a housemate's
  // shared database by name is a feature there, and `readonly` is its write gate.
  const bare = guard.normalize(sql);

  const first = guard.firstKeyword(bare);
  if (!guard.READ_STATEMENTS.includes(first)) {
    return res.status(403).json({ error: 'Only SELECT queries are allowed' });
  }

  // A table function was never the only way out. `SELECT count() FROM system.users`
  // returned 2, and a database-qualified name reads any database the credential can see —
  // which after `deploy --local` is all of them, because that path makes the member the
  // superuser. The error text said "this endpoint reads only this house"; make that true.
  const OWN_DB = (process.env.MEMHOUSE_DB || 'mem').toLowerCase();
  for (const m of bare.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/g)) {
    const db = m[1].toLowerCase();
    // A bare `alias.column` is the overwhelmingly common case and is not a database
    // reference; only refuse names that actually resolve to another DATABASE.
    if (db === OWN_DB) continue;
    if (db === 'system' || KNOWN_DBS.has(db)) {
      return res.status(403).json({ error: `'${m[1]}' is another database — this endpoint reads only '${process.env.MEMHOUSE_DB || 'mem'}'` });
    }
  }

  for (const name of guard.tableFunctions(bare)) {
    if (!guard.ALLOWED_TABLE_FNS.has(name.toLowerCase())) {
      return res.status(403).json({ error: `table function ${name}() is not allowed here — this endpoint reads only this house` });
    }
  }

  try { res.json(await qy.rawQuery(sql)); }
  catch (err) { res.status(400).json({ error: err.message }); }
}));

app.get('/api/schema', route(async (req, res) => res.json(await qy.schema())));

app.get('/api/config', (req, res) => res.json(readConfig()));
// Only the keys the dashboard actually owns. `Object.assign(config, req.body)` persisted
// whatever was sent — `{"pwned":"yes"}` came back 200 and stayed in the file.
const CONFIG_KEYS = { hiddenProjects: 'array', hiddenFolders: 'array' };
app.put('/api/config', route(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Own keys only. `{"__proto__":{…}}` has no OWN key, so `Object.keys` saw an empty body,
  // the unknown-key check passed, and the config was rewritten to {} with a 200.
  const unknown = Object.keys(body).filter((k) => !Object.prototype.hasOwnProperty.call(CONFIG_KEYS, k));
  if (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null) {
    return res.status(400).json({ error: 'unexpected body' });
  }
  if (!Object.keys(body).length) return res.status(400).json({ error: 'no config keys given' });
  if (unknown.length) return res.status(400).json({ error: `unknown config keys: ${unknown.join(', ')}` });
  const config = readConfig();
  for (const [k, kind] of Object.entries(CONFIG_KEYS)) {
    if (!(k in body)) continue;
    if (kind === 'array') {
      if (!Array.isArray(body[k]) || body[k].some((v) => typeof v !== 'string')) {
        return res.status(400).json({ error: `${k} must be an array of strings` });
      }
      config[k] = body[k];
    }
  }
  writeConfig(config);
  res.json(config);
}));

// Real refetch: run one full shipper pass, streaming SSE like the root contract.
// POST, not GET. A full re-ship behind a GET is the easiest request on a machine to make
// by accident — a prefetch, a link checker, a curl in a log. The dashboard calls it
// explicitly, so nothing legitimate depended on the verb.
app.post('/api/refetch', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  try {
    const { runShip } = require('../shipper/ship');
    res.write(`data: ${JSON.stringify({ scanned: 0, analyzed: 0, skipped: 0, total: 0 })}\n\n`);
    const r = await runShip(qy.getClient(), { full: true });
    res.write(`data: ${JSON.stringify({ done: true, total: r.sessions + r.skipped, analyzed: r.sessions })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// Not applicable to memhouse (dashboard renders these pages empty/absent).
app.get('/api/usage', (req, res) => res.json([]));
app.get('/api/artifacts', (req, res) => res.json([]));
app.get('/api/artifact-content', (req, res) => res.status(404).json({ error: 'not available in memhouse' }));
app.get('/api/mcps', (req, res) => res.json({
  servers: [], toolCalls: [], matchedTools: {}, topSessions: [], projectMcps: [],
  summary: { totalServers: 0, totalToolCalls: 0, uniqueTools: 0, sessionsWithTools: 0, editorsWithServers: [] },
}));
app.get('/api/gsd/projects', (req, res) => res.json([]));
app.get('/api/gsd/phases', (req, res) => res.json([]));
app.get('/api/gsd/plan', (req, res) => res.status(404).json({ error: 'not available in memhouse' }));
app.get('/api/gsd/overview', (req, res) => res.json({ totalProjects: 0, totalPhases: 0, completedPhases: 0, activePhases: [], executingPhases: 0, plannedPhases: 0 }));
app.get('/api/gsd/config', (req, res) => res.json(null));
app.get('/api/gsd/phase-tokens', (req, res) => res.json([]));
app.get('/api/gsd/file', (req, res) => res.json({ content: null }));
app.get('/api/share-image', (req, res) => res.status(501).json({ error: 'not available in memhouse' }));
app.get('/api/check-ai', (req, res) => res.status(501).json({ error: 'not available in memhouse' }));

// ── MCP over Streamable HTTP (2026-07-28) ───────────────────────────────────────
// The same rpc.js the stdio transport uses; this route only unwraps HTTP. One
// endpoint, POST only — the 2026-07-28 revision removed the GET stream, sessions
// (Mcp-Session-Id), and SSE resumability (Last-Event-ID), so legacy artifacts of
// all three are ignored or answered 405, never honored. Stateless by
// construction: a fresh rpc state per request, era chosen from what the request
// itself carries.
const mcp = require('../mcp/rpc');
const MCP_META_V = 'io.modelcontextprotocol/protocolVersion';
// Legacy revisions this dual-era server serves with initialize-handshake
// semantics. A version outside this set and not 2026-07-28 is refused -32022.
const MCP_LEGACY = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);

// The Mcp-Name header may carry the base64 sentinel when the value is not
// header-safe; servers MUST decode before comparing to the body.
function decodeMcpHeader(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v || '');
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

// DNS-rebinding defense (spec MUST): a browser page on an attacker's origin can
// POST to 127.0.0.1. An absent Origin is a non-browser caller (curl, an MCP
// client) and passes; a present one must be a local page.
function mcpOriginOk(origin) {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch { return false; }
}

app.post('/mcp', async (req, res) => {
  const send = (status, obj) =>
    res.status(status).type('application/json').send(mcp.scrub(JSON.stringify(obj)));
  if (!mcpOriginOk(req.get('origin'))) {
    return send(403, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } });
  }
  const body = req.body;
  const id = body && body.id !== undefined ? body.id : null;
  const headerV = req.get('mcp-protocol-version');
  const bodyV = body && body.params && body.params._meta ? body.params._meta[MCP_META_V] : undefined;
  const reject = (msg) =>
    send(400, { jsonrpc: '2.0', id, error: { code: -32020, message: `Header mismatch: ${msg}` } });

  // Era: modern the moment either side of the version pair says 2026-07-28 —
  // then BOTH sides must, and the routing headers become mandatory and checked
  // against the body (a balancer routes on the header while this server executes
  // the body; disagreement is an attack, not a typo).
  const modern = headerV === mcp.MODERN || bodyV === mcp.MODERN;
  if (modern) {
    if (headerV !== mcp.MODERN) return reject(`MCP-Protocol-Version header '${headerV || ''}' does not match body value '${bodyV}'`);
    if (bodyV !== mcp.MODERN) return reject(`body _meta protocolVersion '${bodyV || ''}' does not match MCP-Protocol-Version header '${headerV}'`);
    const method = req.get('mcp-method');
    if (!method || method !== body.method) return reject(`Mcp-Method header '${method || ''}' does not match body method '${body.method}'`);
    if (body.method === 'tools/call') {
      const name = decodeMcpHeader(req.get('mcp-name'));
      const bodyName = body.params && body.params.name;
      if (!name || name !== bodyName) return reject(`Mcp-Name header '${name || ''}' does not match body value '${bodyName}'`);
    }
  } else if (headerV && !MCP_LEGACY.has(headerV)) {
    return send(400, {
      jsonrpc: '2.0', id,
      error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [mcp.MODERN, ...MCP_LEGACY], requested: headerV } },
    });
  }

  // handle() guards its own tool calls, but express 4 does not catch an async
  // throw — an unexpected exception here would become an unhandled rejection,
  // or worse, the default HTML error page with an UNSCRUBBED stack. Everything
  // that leaves this route goes through send(), which scrubs.
  try {
    const state = mcp.newState();
    if (!modern) state.era = 'legacy'; // over HTTP the version pair is decisive — no lenient-modern guess
    const out = await mcp.handle(body, state);
    if (!out) return res.status(202).end(); // notification accepted
    const status = out.error ? (out.error.code === -32601 ? 404 : out.error.code === -32603 ? 500 : 400) : 200;
    return send(status, out);
  } catch (e) {
    console.error(`[memhouse] /mcp: ${mcp.scrub(String(e && e.stack || e))}`);
    return send(500, { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
  }
});

// The 2026-07-28 endpoint has no GET stream and no DELETE-to-end-session. This
// must be registered here, before the SPA fallback eats GET /mcp.
app.all('/mcp', (req, res) =>
  res.status(405).set('Allow', 'POST').json({ error: 'the MCP endpoint accepts POST only (2026-07-28 revision: no GET stream, no session DELETE)' }));

// SPA fallback
app.get('*', (req, res) => {
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(503).json({ error: 'UI not built — run: cd ui && npm install && npm run build' });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[memhouse] dashboard → http://localhost:${PORT} (house '${qy.config.database}' @ ${qy.config.url.replace(/\/\/.*@/, '//')})`
      + (HOST !== '127.0.0.1' ? ` [bound to ${HOST} — remotely reachable]` : ''));
  });
  // An upgrade replaces public/ as well as the code, and this process holds neither: the
  // static middleware bound to the old directory at boot, so the SPA it serves stays the
  // old bundle however many times the pilot reloads. The shipper checks once per pass; a
  // server has no pass, so it polls. unref() so the timer never holds the process open.
  const selfUpdate = require('../self-update');
  const snap = selfUpdate.snapshot(__filename);
  setInterval(() => selfUpdate.maybeRestart({ snap, name: 'dashboard', log: console.log }), 60_000).unref();
}

module.exports = app;
