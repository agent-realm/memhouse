-- mem-house HOUSE schema — the typed common session store (see DESIGN.md).
--
-- Applied by the agency OWNER (`memhouse_root`) inside its own house; names are
-- UNQUALIFIED so this works whatever the operator named the house. Requires
-- ClickHouse >= 26.2 (JSON type + text indexes).
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
-- BREAKING (pre-release): the user_id-in-key change alters ORDER BY, which
-- CREATE TABLE IF NOT EXISTS will NOT apply to an existing house — recreate with
-- `memhouse reset` (or DROP the tables and re-run --ensure-schema).

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
    dateDiff('second', min(m.ts), max(m.ts)) AS duration_sec,
    count() AS total_msgs,
    countIf(m.role = 'user') AS user_msgs,
    countIf(m.role = 'assistant') AS assistant_msgs,
    countIf(m.is_subagent) AS subagent_msgs,
    groupUniqArrayIf(m.model, m.model NOT IN ('', '<synthetic>')) AS models,
    sum(m.input_tokens) AS input_tokens,
    sum(m.output_tokens) AS output_tokens,
    sum(m.cache_read_tokens) AS cache_read_tokens,
    sum(m.cache_write_tokens) AS cache_write_tokens,
    sumIf(length(m.text), m.role = 'user') AS user_chars,
    sumIf(length(m.text), m.role = 'assistant') AS assistant_chars,
    substring(argMinIf(m.text, m.seq, m.role = 'user' AND m.text != ''), 1, 200) AS first_prompt
FROM sessions AS s
INNER JOIN messages AS m ON m.session_id = s.session_id AND m.user_id = s.user_id
GROUP BY s.session_id, s.user_id;
