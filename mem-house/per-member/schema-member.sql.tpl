-- mem — one member's rooms. Applied per member; {{MEMBER}} is the ClickHouse username.
--
-- Room bodies are the typed common schema from ../schema.sql, unchanged except for the
-- names. Room naming is TYPE-FIRST (sessions_<m>, not <m>_sessions) so the Merge rooms
-- can anchor on a fixed room type and never match themselves.
--
-- user_id MATERIALIZED currentUser() is retained even though the room names the member:
-- it keeps provenance across a share and keeps the Merge rooms meaningful. Writers must
-- use async_insert=0 or the stamp does not happen.
--
-- ClickHouse >= 26.2 natively; 25.11 works because the shipper passes
-- allow_experimental_full_text_index=1 per-query when applying this file.

CREATE TABLE IF NOT EXISTS sessions_{{MEMBER}}
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

CREATE TABLE IF NOT EXISTS messages_{{MEMBER}}
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

CREATE TABLE IF NOT EXISTS tool_calls_{{MEMBER}}
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

-- NO sessions_v HERE, deliberately. The session rollup is a SAVED QUERY substituted
-- with these room names and run under the caller's own credential (see rooms.js
-- sessionsRollup). A stored view would need a name inside the `^sessions_` namespace
-- the Merge rooms select on, a fourth grant, and a fourth object to provision and roll
-- forward — for nothing the query does not already do.
