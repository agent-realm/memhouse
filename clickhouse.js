// Endpoint-agnostic ClickHouse connection for the analytics cache.
//
// The same code runs against a local clickhouse-server, ClickHouse Cloud, or an
// embedded/kernel-hosted instance — only the CLICKHOUSE_* env vars change. This is
// the replacement for the embedded SQLite cache (better-sqlite3 / ~/.agentlytics/
// cache.db): storage is now a real ClickHouse database reachable anywhere.
//
// Config resolution: process.env first, then a local `.env` file (dev convenience,
// gitignored), then local-server defaults. No dotenv dependency — tiny inline loader.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@clickhouse/client');

// --- Minimal .env loader (no dependency). Does not override already-set env. ---
function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue; // skip blanks and `# comments`
      const [, key, rawVal] = m;
      let val = rawVal;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* no .env — rely on real env / defaults */ }
}
loadDotEnv();

const config = {
  url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_DATABASE || 'agentlytics',
};

let _client = null;

// Lazily create a singleton client. The client is connectionless (HTTP), so this
// is cheap; we reuse it to share the keep-alive pool.
function getClient() {
  if (_client) return _client;
  _client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    request_timeout: 60000, // cloud instances can cold-start; don't cut queries short
    clickhouse_settings: {
      // Make ReplacingMergeTree collapse duplicates at read time so the cache
      // upsert pattern (append-new-version) reads back deduplicated.
      final: 1,
      // Return Int64/UInt64 as JSON numbers, not quoted strings, so the getters'
      // arithmetic works. All our values (tokens, ms timestamps) are < 2^53.
      output_format_json_quote_64bit_integers: 0,
    },
  });
  return _client;
}

// Ensure the target database exists (idempotent). Requires a user allowed to
// CREATE DATABASE, or an already-existing DB — falls back silently if it exists.
async function ensureDatabase() {
  // Connect without a fixed database to run the CREATE DATABASE, then the normal
  // client (bound to `config.database`) is used everywhere else.
  const admin = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    request_timeout: 60000,
  });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.database}` });
  } finally {
    await admin.close();
  }
}

async function ping() {
  const rs = await getClient().query({ query: 'SELECT version() AS v', format: 'JSONEachRow' });
  return (await rs.json())[0].v;
}

module.exports = { getClient, ensureDatabase, ping, config };
