#!/usr/bin/env node
// memhouse solo — a single-user house with no ClickHouse server.
//
// A local HTTP shim that speaks enough of the ClickHouse HTTP interface for memhouse's
// own components, backed by chdb (an embedded ClickHouse) with a persistent data path.
// The shipper, the REST server, the dashboard and the skills all already speak that
// interface, so none of them change: they point at http://127.0.0.1:<port> and cannot
// tell the difference.
//
// WHAT THIS TIER IS NOT. chdb has no users, no GRANT, no row policies — that is what
// separates it from a ClickHouse server. So solo is exactly one person's memory:
//   * no sharing, no members, no kernel
//   * `user_id` is stamped 'default' for every row — it is provenance decoration here,
//     NOT an isolation boundary, because there is only ever one identity
//   * the per-member room layout does not apply; solo uses the shared-room schema
// If two people or two identities need separating, that is the server tier, not this.
//
// Binds loopback only, and there is no auth: anything that can reach the port can read
// every transcript. That is acceptable only because it is 127.0.0.1 on one person's
// machine — do not expose it.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.MEMHOUSE_SOLO_PORT || '8123', 10);
const DATA = process.env.MEMHOUSE_SOLO_DATA
  || path.join(process.env.MEMHOUSE_HOME || path.join(os.homedir(), '.memhouse'), 'solo-data');
const DEBUG = process.env.MEMHOUSE_SOLO_DEBUG === '1';

let Session;
try {
  ({ Session } = require('chdb'));
} catch (e) {
  console.error('[solo] chdb is not installed. It is an optional dependency:');
  console.error('       npm install -g memhouse --allow-scripts=better-sqlite3,chdb');
  process.exit(2);
}

fs.mkdirSync(DATA, { recursive: true });
const session = new Session(DATA);

// The client sends the format three ways depending on the call: appended to the SQL as
// `FORMAT X`, as a `default_format` query param, or not at all. chdb takes the format as
// an argument, and an explicit FORMAT in the SQL wins over it, so passing the param's
// value as the default is safe either way.
function formatFor(url, sql) {
  if (/\bFORMAT\s+\w+\s*;?\s*$/i.test(sql)) return 'CSV'; // ignored — SQL's own FORMAT wins
  const f = url.searchParams.get('default_format');
  return f || 'JSONEachRow';
}

// A statement that returns no rows must produce an empty body, not chdb's "(ok)"-ish
// output, or @clickhouse/client's command() path chokes trying to parse it.
const NO_ROWS = /^\s*(CREATE|DROP|ALTER|INSERT|SET|TRUNCATE|RENAME|OPTIMIZE|USE|GRANT|REVOKE|DETACH|ATTACH)\b/i;

// chdb sessions ARE stateful: a bare `USE db` persists for later queries. So the
// database is switched once, not prefixed onto every statement.
//
// Prefixing was wrong for a reason worth keeping: the client sends `?database=X` on
// EVERY request, including the `CREATE DATABASE X` that brings X into existence. A
// `USE X; CREATE DATABASE X` fails with UNKNOWN_DATABASE before it can create anything.
let currentDb = null;

function dbExists(name) {
  try {
    const out = String(session.query(
      `SELECT count() FROM system.databases WHERE name = '${name.replace(/'/g, "''")}'`, 'CSV')).trim();
    return out.replace(/"/g, '') !== '0';
  } catch { return false; }
}

// Named query parameters. `@clickhouse/client` leaves `{id:String}` in the SQL and sends
// the value as a `param_id` URL parameter — that is how the shipper's per-session DELETE
// and every dashboard `getChat`/search query are written. chdb has no such transport, but
// it does honour `SET param_<name> = ...`, and its sessions are stateful, so binding is a
// SET issued immediately before the query.
//
// Which makes leftovers the hazard: a param set by an earlier request stays set, so a
// query whose parameter went missing would silently read someone else's value instead of
// failing. Every placeholder the SQL mentions must therefore be supplied by THIS request.
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[^{}]+\}/g;

function chLiteral(v) {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function bindParams(url, sql) {
  const supplied = new Map();
  for (const [k, v] of url.searchParams) if (k.startsWith('param_')) supplied.set(k.slice(6), v);

  const wanted = new Set();
  for (const m of sql.matchAll(PLACEHOLDER)) wanted.add(m[1]);
  for (const name of wanted) {
    // Same shape as ClickHouse's own message for an unbound substitution, so callers
    // that read `Code:` and the text behave identically against a real server.
    if (!supplied.has(name)) {
      const e = new Error(`Code: 456. DB::Exception: Substitution \`${name}\` is not set. (UNKNOWN_QUERY_PARAMETER)`);
      throw e;
    }
  }
  for (const [name, value] of supplied) {
    if (wanted.has(name)) session.query(`SET param_${name} = ${chLiteral(value)}`, 'CSV');
  }
}

// ClickHouse settings ride on the URL, and dropping them is not cosmetic. Every read
// memhouse issues sends `final=1`: without it a re-shipped session's superseded
// ReplacingMergeTree versions stay visible until some future background merge, and
// `sessions_v` joins EVERY visible version of a session to its messages — so token and
// message totals multiply. The dashboard would just be wrong, with nothing to see.
//
// Everything on the URL that is not one of the protocol parameters below is treated as a
// setting. chdb accepts `SET x = v` and `SET x = DEFAULT` (measured), so a setting sent by
// one request is reverted before the next, and the session does not accumulate state.
const PROTOCOL_PARAMS = new Set(['query', 'database', 'default_format', 'query_id', 'session_id']);
// If one of these cannot be applied, failing loudly beats answering with wrong numbers.
const CRITICAL_SETTINGS = new Set(['final', 'async_insert']);
let appliedSettings = new Set();

function applySettings(url) {
  const want = new Map();
  for (const [k, v] of url.searchParams) {
    if (PROTOCOL_PARAMS.has(k) || k.startsWith('param_')) continue;
    want.set(k, v);
  }
  // Revert anything a previous request set that this one does not.
  for (const k of appliedSettings) {
    if (!want.has(k)) { try { session.query(`SET ${k} = DEFAULT`, 'CSV'); } catch { /* already default */ } }
  }
  const applied = new Set();
  for (const [k, v] of want) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue; // not a settings identifier
    try {
      session.query(`SET ${k} = ${chLiteral(v)}`, 'CSV');
      applied.add(k);
    } catch (e) {
      if (CRITICAL_SETTINGS.has(k)) {
        throw new Error(`Code: 115. DB::Exception: cannot apply setting '${k}': ${String((e && e.message) || e).split('\n')[0]} (UNKNOWN_SETTING)`);
      }
      if (DEBUG) console.error(`[solo] ignoring unsupported setting ${k}`);
    }
  }
  appliedSettings = applied;
}

// `statement` is the SQL alone, never the INSERT data block appended to it. ClickHouse
// does not substitute inside that block, and a transcript whose text happens to contain
// `{id:String}` would otherwise be read as an unbound placeholder and rejected — memhouse
// ships conversations *about* ClickHouse, so that is a live case, not a hypothetical.
//
// LOAD-BEARING: binding then querying is atomic only because `session.query` is
// synchronous and this whole function runs inside one turn of the event loop, so two
// requests cannot interleave their `SET param_*` with each other's query. Making any of
// this async — a worker pool, a promise-returning chdb binding — would let request B's
// parameters land between request A's SET and A's query, and A would silently read B's
// values. If that day comes, serialize explicitly instead of relying on this note.
function run(sql, fmt, database, url, statement) {
  if (database && database !== currentDb && dbExists(database)) {
    session.query(`USE ${database}`, 'CSV');
    currentDb = database;
  }
  if (url) { applySettings(url); bindParams(url, statement); }
  return session.query(sql, fmt);
}

const server = http.createServer((req, res) => {
  // Collect Buffers and decode ONCE. `body += chunk` decodes each chunk on its own, so a
  // multi-byte UTF-8 sequence straddling a chunk boundary is silently replaced with U+FFFD
  // — and an insert body carrying tens of thousands of rows straddles many boundaries.
  // The damage is invisible: the insert succeeds, the transcript is just quietly wrong.
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/ping') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Ok.\n'); }

    // Two shapes, and conflating them breaks inserts. A plain query arrives as the POST
    // body. An INSERT arrives as `?query=INSERT INTO t FORMAT JSONEachRow` with the ROWS
    // as the body — so when both are present the body is data, not SQL, and the two are
    // concatenated exactly as a real server would read them off the wire.
    const qParam = url.searchParams.get('query');
    const bodyText = body && body.trim() ? body : '';
    const sql = qParam && bodyText ? `${qParam}\n${bodyText}`
      : (qParam || bodyText || '');
    if (!sql.trim()) { res.writeHead(400); return res.end('no query\n'); }
    // The SQL alone — the insert data block, when there is one, is not part of it.
    const statement = qParam && bodyText ? qParam : sql;

    const database = url.searchParams.get('database') || '';
    const fmt = formatFor(url, sql);
    if (DEBUG) {
      console.error(`[solo] ${req.method} ${req.url}`);
      console.error(`[solo]   qParam=${qParam ? JSON.stringify(qParam.slice(0, 90)) : 'null'}`);
      console.error(`[solo]   body[0:90]=${JSON.stringify(bodyText.slice(0, 90))}`);
      console.error(`[solo]   headers=${JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k]) => /clickhouse|content-type/i.test(k))))}`);
    }

    try {
      const out = run(sql, fmt, database, url, statement);
      const text = out == null ? '' : String(out);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8', 'X-ClickHouse-Server-Display-Name': 'memhouse-solo' });
      res.end(NO_ROWS.test(qParam || bodyText) ? '' : text);
    } catch (e) {
      // Shape the error like ClickHouse's so callers that parse `Code: NN` still work.
      const msg = String((e && e.message) || e);
      if (DEBUG) console.error(`[solo] ERROR ${msg.split('\n')[0]}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end(/^Code:\s*\d+/.test(msg) ? msg : `Code: 1. DB::Exception: ${msg}\n`);
    }
  });
});

// Without this, a port clash exits with an unhandled-exception stack trace, which under a
// service manager becomes a restart loop whose logs never say what is wrong.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[solo] port ${PORT} is already in use — another solo house is running.`);
    console.error('[solo] stop it first (memhouse stop), or set MEMHOUSE_SOLO_PORT to a free port.');
    process.exit(3);
  }
  console.error(`[solo] server error: ${e && e.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[solo] memhouse solo house on http://127.0.0.1:${PORT}  data=${DATA}`);
  console.log('[solo] single user, no auth, loopback only — not a shared house');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); try { session.cleanup?.(); } catch { /* best effort */ } process.exit(0); });
}
