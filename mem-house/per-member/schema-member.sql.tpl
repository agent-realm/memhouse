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

-- The member's own sessions_v. The read layer — dashboard, CLI status/search/doctor,
-- `ship --stats` — reads the view rather than the base rooms, so a per-member house needs
-- one per member or nothing can read back what was shipped. Body is ../schema.sql's view
-- verbatim, over this member's rooms.
--
-- NAMED `v_sessions_<m>`, NOT `sessions_v_<m>`. The Merge rooms select on `^sessions_`,
-- which would otherwise match the view and try to merge an aggregate into the base
-- session rooms — same columns it is grouping by, different shape. The `v_` prefix puts
-- every view outside every room type's namespace, and `rooms.js` reserves it so no member
-- can be named into the collision.
--
-- CREATE OR REPLACE (not IF NOT EXISTS) so a schema roll-forward updates the view in
-- place, matching how the shared schema is applied.
CREATE OR REPLACE VIEW v_sessions_{{MEMBER}} AS
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
FROM sessions_{{MEMBER}} AS s
LEFT JOIN messages_{{MEMBER}} AS m ON m.session_id = s.session_id AND m.user_id = s.user_id
GROUP BY s.session_id, s.user_id
SETTINGS join_use_nulls = 1;
