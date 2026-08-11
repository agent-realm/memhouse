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

app.post('/api/query', route(async (req, res) => {
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'sql string required' });
  // ONE pass. Strings and comments have to be recognised in the order they actually
  // appear, because each can contain the other's opening marker:
  //
  //   SELECT * FROM /* ' */ url('http://…')   -- a quote inside a comment
  //   SELECT '--', url('http://…')            -- a comment marker inside a string
  //
  // Stripping literals first lets the first one through: the `'` inside the comment opens
  // a "literal" that swallows `' */ url('`, so the function scan sees nothing and the
  // query runs. Stripping comments first lets the second one through for the mirror
  // reason. Both were reachable; the first was demonstrated fetching a remote URL. A
  // regex pipeline cannot do this — the two constructs are mutually nesting, so it takes
  // a scanner.
  let bare = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === quote) {
          if (quote === "'" && sql[i + 1] === "'") { i += 2; continue; }  // '' escape
          i++; break;
        }
        i++;
      }
      bare += quote + quote;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      bare += ' ';
    } else if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      bare += ' ';
    } else {
      bare += c;
      i++;
    }
  }

  const first = bare.trim().split(/\s+/)[0].toUpperCase();
  if (!['SELECT', 'WITH', 'EXPLAIN', 'DESCRIBE', 'SHOW'].includes(first)) {
    return res.status(403).json({ error: 'Only SELECT queries are allowed' });
  }
  // Checking the FIRST TOKEN says nothing about the rest of the statement. ClickHouse's
  // table functions live inside a SELECT, and `url()` makes an outbound HTTP request from
  // the server — reachable here with no authentication at all. Measured: the response
  // carried the TARGET's error, so the request went out. On a house provisioned per-member
  // this is blocked by grants (READ ON URL is not granted), but `install --url … --user
  // memhouse_root` is a documented path and that credential holds everything.
  //
  // `file()` is jailed by ClickHouse's user_files directory and `remote()`/`s3()` are the
  // same shape as url(). Refuse the family by name rather than trusting least privilege to
  // be configured.
  // Allow-list the table functions instead of naming the dangerous ones. The deny-list
  // missed gcs, sqlite, redis, hudi, fileCluster, azureBlobStorageCluster, icebergS3,
  // deltaLakeS3 and fuzzJSON — three of which reached ClickHouse and failed only on URI
  // parsing, meaning a well-formed URI would have made the request. ClickHouse ships more
  // than anyone can enumerate, and it gains more every release; the set this endpoint
  // legitimately needs is tiny and does not grow.
  const ALLOWED_FN = new Set(['numbers', 'values', 'null', 'generateseries', 'format', 'view', 'merge']);
  // A table function can appear anywhere in a FROM clause, not only straight after the
  // FROM or JOIN keyword. Checking only those two positions missed the comma join:
  //   SELECT * FROM numbers(1) AS n, /* ' */ url('http://…')
  // which reached ClickHouse and was parsed as a table function. So: find each FROM
  // clause and check every call inside it. Outside a FROM clause a call is an ordinary
  // scalar or aggregate — flagging those would refuse `SELECT count(), sum(x)`.
  const CLAUSE_END = /\b(WHERE|PREWHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|SETTINGS|UNION|INTO|FORMAT|WINDOW|QUALIFY)\b/i;
  const upper = bare.toUpperCase();
  for (const kw of upper.matchAll(/\bFROM\b/g)) {
    const rest = bare.slice(kw.index + 4);
    const stop = rest.match(CLAUSE_END);
    const clause = rest.slice(0, stop ? stop.index : rest.length);
    for (const m of clause.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const name = m[1].toLowerCase();
      if (!ALLOWED_FN.has(name)) {
        return res.status(403).json({ error: `table function ${m[1]}() is not allowed here — this endpoint reads only this house` });
      }
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
}

module.exports = app;
