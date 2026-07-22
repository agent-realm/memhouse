// agentlytics agency — owner service-loop (entrypoint).
//
// Connects as the kernel-issued owner (`agentlytics_root`) to its house, ensures the
// realm session schema exists, and ingests all local editor sessions into house.raw.
// The kernel provisioned the house + this credential via `install-agency`; the kernel
// never runs this — it's content-blind. This process IS the agency's deterministic
// worker tier.
//
//   node agency/agency.js          # one ingest pass
//   node agency/agency.js --loop   # re-ingest every 60s
//
// Config (env; falls back to the CLICKHOUSE_* used elsewhere, then a local kernel):
//   HOUSE_CLICKHOUSE_URL       e.g. https://<kernel-host>:8443  (default http://localhost:8123)
//   HOUSE_CLICKHOUSE_USER      the agency owner (default agentlytics_root)
//   HOUSE_CLICKHOUSE_PASSWORD  the credential from `install-agency` (rotate on first use)
//   HOUSE_CLICKHOUSE_DATABASE  the house / agency name (default agentlytics)

const fs = require('fs');
const path = require('path');
const { createClient } = require('@clickhouse/client');
const { runIngest } = require('./ingest');

const config = {
  url: process.env.HOUSE_CLICKHOUSE_URL || process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.HOUSE_CLICKHOUSE_USER || process.env.CLICKHOUSE_USER || 'agentlytics_root',
  password: process.env.HOUSE_CLICKHOUSE_PASSWORD || process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.HOUSE_CLICKHOUSE_DATABASE || 'agentlytics',
};

async function ensureSchema(client) {
  const sql = fs.readFileSync(path.join(__dirname, 'house-schema.sql'), 'utf-8');
  // Strip `--` line comments first (a comment may contain ';'), then split on ';'.
  const stripped = sql.split('\n').map((ln) => { const i = ln.indexOf('--'); return i < 0 ? ln : ln.slice(0, i); }).join('\n');
  for (const stmt of stripped.split(';').map((s) => s.trim()).filter(Boolean)) {
    await client.command({ query: stmt });
  }
}

(async () => {
  const loop = process.argv.includes('--loop');
  const client = createClient({ ...config, request_timeout: 60000 });
  console.log(`[agency] house '${config.database}' @ ${config.url.replace(/\/\/.*@/, '//')} as ${config.username}`);
  await ensureSchema(client);
  console.log('[agency] realm session schema ready (raw + messages_v + sessions_v)');
  do {
    const t0 = Date.now();
    const r = await runIngest(client);
    console.log(`[agency] shipped ${r.rows} message-rows from ${r.sessions} sessions (${r.editors} chats) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (loop) await new Promise((res) => setTimeout(res, 60000));
  } while (loop);
  await client.close();
})().catch((e) => { console.error('[agency] failed:', e.message); process.exit(1); });
