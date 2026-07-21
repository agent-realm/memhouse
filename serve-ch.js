// Minimal launcher for the ClickHouse-backed dashboard (interim; the full index.js
// cutover — banner/TUI/port-scan without better-sqlite3 — comes later). Ensures the
// schema exists and serves the prebuilt UI + REST API. The cache DB is already
// populated, so no scan is needed to view the dashboard.
const cache = require('./cache');
const app = require('./server');

const PORT = process.env.PORT || 4637;

(async () => {
  await cache.initDb(); // idempotent: ensure DB + schema
  app.listen(PORT, () => {
    console.log(`agentlytics (ClickHouse) → http://localhost:${PORT}`);
  });
})().catch((e) => { console.error('launch failed:', e); process.exit(1); });
