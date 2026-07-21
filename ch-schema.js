// ClickHouse schema for the analytics cache — the replacement for the embedded
// SQLite schema in cache.js (initDb / CREATE TABLE ...).
//
// Design notes (SQLite → ClickHouse):
//   - Timestamps stay as epoch-ms Int64 (exactly what the adapters + JS expect),
//     Nullable where SQLite allowed NULL.
//   - Tables that SQLite *upserted* (INSERT OR REPLACE: chats, chat_stats, meta,
//     gsd_projects) become ReplacingMergeTree(_ver): re-ingest appends a row with a
//     higher _ver, reads collapse to the latest. The client sets `final=1` so plain
//     SELECTs already see the deduplicated (latest) row.
//   - Tables that SQLite rewrote via DELETE-then-INSERT per chat (messages,
//     tool_calls, gsd_phases) are plain MergeTree; the ingest layer clears a chat's
//     old rows with a lightweight DELETE before re-inserting (only on re-analysis;
//     a first scan is insert-only).
//   - SQLite AUTOINCREMENT ids are dropped; ordering is carried by explicit columns
//     (messages.seq, tool_calls.idx) that the ingest layer assigns.

const SCHEMA_VERSION = 1; // bump when any DDL below changes → triggers drop+recreate

// name → CREATE TABLE body. Order matters only for drop/create symmetry.
const TABLES = {
  chats: `(
    id String,
    source String,
    name Nullable(String),
    mode Nullable(String),
    folder Nullable(String),
    created_at Nullable(Int64),
    last_updated_at Nullable(Int64),
    encrypted UInt8 DEFAULT 0,
    bubble_count Int64 DEFAULT 0,
    _meta String DEFAULT '{}',
    _ver UInt64
  ) ENGINE = ReplacingMergeTree(_ver) ORDER BY id`,

  chat_stats: `(
    chat_id String,
    total_messages Int64 DEFAULT 0,
    user_messages Int64 DEFAULT 0,
    assistant_messages Int64 DEFAULT 0,
    tool_messages Int64 DEFAULT 0,
    system_messages Int64 DEFAULT 0,
    tool_calls String DEFAULT '[]',
    models String DEFAULT '[]',
    total_user_chars Int64 DEFAULT 0,
    total_assistant_chars Int64 DEFAULT 0,
    total_input_tokens Int64 DEFAULT 0,
    total_output_tokens Int64 DEFAULT 0,
    total_cache_read Int64 DEFAULT 0,
    total_cache_write Int64 DEFAULT 0,
    analyzed_at Int64,
    _ver UInt64
  ) ENGINE = ReplacingMergeTree(_ver) ORDER BY chat_id`,

  messages: `(
    chat_id String,
    seq Int64,
    role String,
    content String,
    model Nullable(String),
    input_tokens Nullable(Int64),
    output_tokens Nullable(Int64),
    cache_read Nullable(Int64),
    cache_write Nullable(Int64)
  ) ENGINE = MergeTree ORDER BY (chat_id, seq)`,

  tool_calls: `(
    chat_id String,
    idx Int64,
    tool_name String,
    args_json String DEFAULT '{}',
    source Nullable(String),
    folder Nullable(String),
    timestamp Nullable(Int64)
  ) ENGINE = MergeTree ORDER BY (chat_id, idx)`,

  meta: `(
    key String,
    value String,
    _ver UInt64
  ) ENGINE = ReplacingMergeTree(_ver) ORDER BY key`,

  gsd_projects: `(
    folder String,
    name Nullable(String),
    description Nullable(String),
    milestone Nullable(String),
    total_phases Int64 DEFAULT 0,
    completed_phases Int64 DEFAULT 0,
    active_phase Nullable(String),
    todos Int64 DEFAULT 0,
    backlog Int64 DEFAULT 0,
    notes Int64 DEFAULT 0,
    last_modified Nullable(Int64),
    scanned_at Int64,
    _ver UInt64
  ) ENGINE = ReplacingMergeTree(_ver) ORDER BY folder`,

  gsd_phases: `(
    id String,
    folder String,
    phase_number Int64,
    phase_name Nullable(String),
    status Nullable(String),
    total_tasks Int64 DEFAULT 0,
    completed_tasks Int64 DEFAULT 0,
    has_plan UInt8 DEFAULT 0,
    has_research UInt8 DEFAULT 0,
    has_verification UInt8 DEFAULT 0,
    last_modified Nullable(Int64)
  ) ENGINE = MergeTree ORDER BY (folder, phase_number)`,
};

async function getStoredVersion(client) {
  try {
    // Check existence first so a fresh DB doesn't log a scary UNKNOWN_TABLE error.
    const ex = await client.query({
      query: "SELECT 1 FROM system.tables WHERE database = currentDatabase() AND name = 'meta' LIMIT 1",
      format: 'JSONEachRow',
    });
    if ((await ex.json()).length === 0) return null;
    const rs = await client.query({
      query: "SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1",
      format: 'JSONEachRow',
    });
    const rows = await rs.json();
    return rows.length ? parseInt(rows[0].value, 10) : null;
  } catch {
    return null; // treat any lookup failure as "no version yet"
  }
}

// Create the tables if needed; if a stored schema version mismatches, drop and
// recreate everything (the ClickHouse equivalent of SQLite wiping the .db file).
async function initSchema(client) {
  const stored = await getStoredVersion(client);
  if (stored !== null && stored !== SCHEMA_VERSION) {
    for (const name of Object.keys(TABLES)) {
      await client.command({ query: `DROP TABLE IF EXISTS ${name}` });
    }
  }
  for (const [name, body] of Object.entries(TABLES)) {
    await client.command({ query: `CREATE TABLE IF NOT EXISTS ${name} ${body}` });
  }
  await client.insert({
    table: 'meta',
    values: [{ key: 'schema_version', value: String(SCHEMA_VERSION), _ver: Date.now() }],
    format: 'JSONEachRow',
  });
}

module.exports = { SCHEMA_VERSION, TABLES, initSchema, getStoredVersion };
