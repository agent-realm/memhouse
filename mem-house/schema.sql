-- mem-house HOUSE schema — the typed common session store (see DESIGN.md).
--
-- Applied by the agency OWNER (`memhouse_root`) inside its own house; names are
-- UNQUALIFIED so this works whatever the operator named the house. Requires
-- ClickHouse >= 26.2 natively; 25.11 also works because the shipper passes
-- allow_experimental_full_text_index=1 per-query when applying this file
-- (the messages text indexes are still gated on 25.x; 26.x+ ignores the flag).
--
-- Parse-on-client: the shipper runs the 17 editor adapters and ships TYPED rows —
-- these tables are the contract. `extra JSON` on each table is the escape hatch for
-- adapter fields not yet normalized (never lose data to the schema).
--
-- Versioning/idempotency: ReplacingMergeTree(ingested_at) everywhere. `messages` is
-- keyed (session_id, user_id, seq): re-shipping a grown or corrected session
-- REPLACES stale rows (latest-wins) instead of accumulating variants, and the
-- user_id in every key means two members shipping the same adapter-local
-- session_id can never collapse or overwrite each other's rows. Identity is
-- server-stamped (`user_id MATERIALIZED currentUser()`; writers must use
-- async_insert=0) and is the RLS anchor (rls.sql). Readers should query with the
-- `final=1` setting.
--
-- session_id is CANONICAL and globally unique: '<source>:<adapter-local id>',
-- stamped by the shipper. Adapter-local ids are only unique within one editor;
-- the source prefix makes every key, incremental comparison, delete, view join,
-- and API id collision-free across editors. `source` remains a plain column for
-- filtering.
--
-- BREAKING (pre-release): the user_id-in-key change alters ORDER BY, which
-- CREATE TABLE IF NOT EXISTS will NOT apply to an existing house — recreate with
-- `memhouse reset` (or DROP the tables and re-run --ensure-schema). The
-- source-prefixed session_id change needs no DDL, but rows shipped before it
-- linger under their old bare ids — run `memhouse reset` once after upgrading.

-- One row per session (adapter-level metadata; aggregates live in sessions_v).
CREATE TABLE IF NOT EXISTS sessions
(
    session_id String,
    source LowCardinality(String),
    host LowCardinality(String),
    name String DEFAULT '',
    mode LowCardinality(String) DEFAULT '',
    folder String DEFAULT '',
    project String DEFAULT '',
    git_branch String DEFAULT '',
    created_at Nullable(DateTime64(3, 'UTC')),
    last_updated_at Nullable(DateTime64(3, 'UTC')),
    message_count UInt32 DEFAULT 0,
    path String DEFAULT '',
    extra JSON,
    user_id String MATERIALIZED currentUser(),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (session_id, user_id);

-- One row per message. FTS: two lower(text) materialized columns each carry one
-- text index (ngram for substring/LIKE, word for token match) — query with
-- lowercased terms, SELECT `text` for display.
CREATE TABLE IF NOT EXISTS messages
(
    session_id String,
    seq UInt32,
    source LowCardinality(String),
    host LowCardinality(String),
    ts DateTime64(3, 'UTC'),
    role LowCardinality(String),
    model LowCardinality(String) DEFAULT '',
    input_tokens UInt64 DEFAULT 0,
    output_tokens UInt64 DEFAULT 0,
    cache_read_tokens UInt64 DEFAULT 0,
    cache_write_tokens UInt64 DEFAULT 0,
    text String,
    project String DEFAULT '',
    folder String DEFAULT '',
    is_subagent Bool DEFAULT false,
    extra JSON,
    line_hash UInt64,
    user_id String MATERIALIZED currentUser(),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    text_ngram String MATERIALIZED lower(text),
    text_word  String MATERIALIZED lower(text),
    INDEX idx_text_ngram text_ngram TYPE text(tokenizer = ngrams(3)) GRANULARITY 1,
    INDEX idx_text_word  text_word  TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (session_id, user_id, seq);

-- One row per tool call (memory-house has no equivalent; this powers the tool
-- analytics). `seq` = owning message's seq; `idx` = call index within the session.
CREATE TABLE IF NOT EXISTS tool_calls
(
    session_id String,
    seq UInt32,
    idx UInt32,
    source LowCardinality(String),
    host LowCardinality(String),
    tool_name LowCardinality(String),
    args String DEFAULT '{}',
    ts DateTime64(3, 'UTC'),
    project String DEFAULT '',
    folder String DEFAULT '',
    user_id String MATERIALIZED currentUser(),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (session_id, user_id, idx);

-- Analytics-ready rollup: session metadata + message aggregates. Query with final=1.
-- LEFT JOIN (not INNER): stable-empty sessions are deliberately stored (the row
-- absorbs the incremental skip) and must stay visible with zero aggregates, not
-- vanish from every dashboard count. join_use_nulls makes unmatched message
-- columns NULL so count(m.seq)/coalesce produce true zeros instead of counting
-- the placeholder row.
CREATE OR REPLACE VIEW sessions_v AS
SELECT
    s.session_id AS session_id,
    any(s.source) AS source,
    any(s.host) AS host,
    any(s.name) AS name,
    any(s.mode) AS mode,
    any(s.folder) AS folder,
    any(s.project) AS project,
    any(s.git_branch) AS git_branch,
    s.user_id AS user_id,
    any(s.created_at) AS created_at,
    any(s.last_updated_at) AS last_updated_at,
    min(m.ts) AS started,
    max(m.ts) AS ended,
    coalesce(dateDiff('second', min(m.ts), max(m.ts)), 0) AS duration_sec,
    count(m.seq) AS total_msgs,
    countIf(m.role = 'user') AS user_msgs,
    countIf(m.role = 'assistant') AS assistant_msgs,
    countIf(m.is_subagent) AS subagent_msgs,
    groupUniqArrayIf(m.model, m.model NOT IN ('', '<synthetic>')) AS models,
    coalesce(sum(m.input_tokens), 0) AS input_tokens,
    coalesce(sum(m.output_tokens), 0) AS output_tokens,
    coalesce(sum(m.cache_read_tokens), 0) AS cache_read_tokens,
    coalesce(sum(m.cache_write_tokens), 0) AS cache_write_tokens,
    coalesce(sumIf(length(m.text), m.role = 'user'), 0) AS user_chars,
    coalesce(sumIf(length(m.text), m.role = 'assistant'), 0) AS assistant_chars,
    coalesce(substring(argMinIf(m.text, m.seq, m.role = 'user' AND m.text != ''), 1, 200), '') AS first_prompt
FROM sessions AS s
LEFT JOIN messages AS m ON m.session_id = s.session_id AND m.user_id = s.user_id
GROUP BY s.session_id, s.user_id
SETTINGS join_use_nulls = 1;
