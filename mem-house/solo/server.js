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

function run(sql, fmt, database) {
  if (database && database !== currentDb && dbExists(database)) {
    session.query(`USE ${database}`, 'CSV');
    currentDb = database;
  }
  return session.query(sql, fmt);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
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

    const database = url.searchParams.get('database') || '';
    const fmt = formatFor(url, sql);
    if (DEBUG) {
      console.error(`[solo] ${req.method} ${req.url}`);
      console.error(`[solo]   qParam=${qParam ? JSON.stringify(qParam.slice(0, 90)) : 'null'}`);
      console.error(`[solo]   body[0:90]=${JSON.stringify(bodyText.slice(0, 90))}`);
      console.error(`[solo]   headers=${JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k]) => /clickhouse|content-type/i.test(k))))}`);
    }

    try {
      const out = run(sql, fmt, database);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[solo] memhouse solo house on http://127.0.0.1:${PORT}  data=${DATA}`);
  console.log('[solo] single user, no auth, loopback only — not a shared house');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); try { session.cleanup?.(); } catch { /* best effort */ } process.exit(0); });
}
