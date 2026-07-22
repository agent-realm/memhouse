-- agentlytics agency — HOUSE schema (the realm session store).
--
-- Run by the agency OWNER (`agentlytics_root`) inside its own house (the DB the
-- kernel provisioned via `install-agency`). Table names are UNQUALIFIED — the owner
-- connects with its house as the default database, so this file is name-agnostic and
-- works whatever the operator called the agency.
--
-- This mirrors memory-house's realm session schema (memory.raw + messages_v +
-- sessions_v) so the two agencies converge at the schema level. The difference and
-- the value-add: memory-house ships raw editor-native transcript lines (its views are
-- Claude-shaped, FTS filtered to source='claude-code'), whereas this agency emits a
-- CANONICAL `data` shape normalized across ALL 17 editors agentlytics supports — so
-- messages_v / sessions_v populate uniformly for editors memory-house can't cover.
--
-- No roles / row policies here: the kernel-issued owner has grant-option on its house
-- but NOT ACCESS MANAGEMENT, so identity + RLS are the kernel's job (register-member
-- + owner GRANT INSERT). Single-writer for now (the owner), so user_id is uniform.

-- Landing table: 6 client-written columns; identity + version stamped server-side.
CREATE TABLE IF NOT EXISTS raw
(
    source LowCardinality(String) DEFAULT 'claude-code',
    host LowCardinality(String),
    config_dir LowCardinality(String),
    path String,
    line_hash UInt64,
    data JSON,
    user_id String MATERIALIZED currentUser(),   -- un-spoofable writer identity (needs async_insert=0)
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (data.sessionId::String, data.timestamp::String, data.uuid::String, line_hash);

-- Typed per-message view over the canonical `data`. Same projection as memory-house
-- messages_v; `project` derives from cwd basename (uniform across editors) with the
-- classic .../projects/<p>/... path regex as a fallback for Claude-native paths.
CREATE OR REPLACE VIEW messages_v AS
SELECT
    source,
    host,
    config_dir,
    user_id,
    if(position(path, '/projects/') > 0,
       replaceRegexpOne(path, '.*/projects/([^/]+)/.*', '\\1'),
       replaceRegexpOne(data.cwd::String, '.*/([^/]+)/?$', '\\1')) AS project,
    data.sessionId::String AS session_id,
    parseDateTime64BestEffort(data.timestamp::String) AS ts,
    data.type::String AS role,
    data.uuid::String AS uuid,
    data.parentUuid::String AS parent_uuid,
    data.isSidechain::Bool AS is_sidechain,
    data.cwd::String AS cwd,
    data.gitBranch::String AS git_branch,
    data.message.model::String AS model,
    data.message.usage.input_tokens::UInt64 AS input_tokens,
    data.message.usage.output_tokens::UInt64 AS output_tokens,
    data.message.usage.cache_read_input_tokens::UInt64 AS cache_read_tokens,
    data.message.usage.cache_creation_input_tokens::UInt64 AS cache_creation_tokens,
    if(dynamicType(data.message.content) = 'String',
       toString(data.message.content),
       arrayStringConcat(
         arrayMap(b -> b.text::String,
           arrayFilter(b -> b.type::String = 'text', data.message.content::Array(JSON))),
         '\n')) AS text
FROM raw
WHERE data.type::String IN ('user', 'assistant');

-- Session rollup — the analytics-ready view (one row per session, all editors).
CREATE OR REPLACE VIEW sessions_v AS
SELECT
    session_id,
    any(user_id) AS user_id,
    any(source) AS source,
    any(host) AS host,
    any(config_dir) AS config_dir,
    any(project) AS project,
    any(cwd) AS cwd,
    anyLast(git_branch) AS git_branch,
    min(ts) AS started,
    max(ts) AS ended,
    dateDiff('second', min(ts), max(ts)) AS duration_sec,
    countIf(role = 'user') AS user_msgs,
    countIf(role = 'assistant') AS assistant_msgs,
    countIf(is_sidechain) AS sidechain_msgs,
    groupUniqArrayIf(model, model NOT IN ('', '<synthetic>')) AS models,
    sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,
    sum(cache_read_tokens) AS cache_read_tokens,
    sum(cache_creation_tokens) AS cache_creation_tokens,
    substring(argMinIf(text, ts, role = 'user' AND text != ''), 1, 200) AS first_prompt
FROM messages_v
GROUP BY session_id;
