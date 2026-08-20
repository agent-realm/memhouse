-- The house's three rooms — plain, shared tables. Everyone in the house writes into
-- these same tables with their own credential; `user_id MATERIALIZED currentUser()`
-- (server-stamped, async_insert pinned to 0 on the user) says who, and `host` says
-- which machine. There is no per-member table and no Merge room: the database IS the
-- boundary, and a housemate is anyone granted on it.
--
-- ClickHouse >= 26.2 natively — 25.11 works because the shipper passes
-- allow_experimental_full_text_index=1 per-query when applying this file.

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
    -- Who put this row here. Carried on every room so a reader can tell shipped rows
    -- from imported ones, and so the shipper's clear can bind origin='ship'.
    --
    -- NOTE the sorting key below does NOT include origin, and sessions is the one room
    -- where that is correct. A session has exactly ONE metadata row: title, counts,
    -- bounds. If origin were in the key, an imported session and its shipped twin would
    -- be two rows, and everything that reads sessions as one-row-per-session breaks --
    -- sessions_v joins messages twice and over-reports (measured on a real house: one
    -- duplicate row inflated the totals by 1,764 messages and 655M tokens), and the
    -- incremental skip cannot decide which row is current. Collapsing them is what we
    -- want: the newer ingested_at wins, which is the shipper's row for any session that
    -- still exists on disk. Nothing is lost -- a session the adapters no longer see is
    -- never cleared and never re-inserted, so its imported row stands untouched.
    --
    -- messages and tool_calls are the opposite case and DO key on origin -- see there.
    origin LowCardinality(String) DEFAULT 'ship',
    user_id String MATERIALIZED currentUser(),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    -- The session's CURRENT parse epoch, for people and for `doctor` — never for reads.
    -- The read filter is computed from the messages room itself (see there), because an
    -- IMPORT writes a sessions row too, and this room is latest-wins with no origin in the
    -- key: an import landing after a shipped epoch bump would hand every reader a 0 and
    -- hide the current transcript. Observability only.
    epoch UInt32 DEFAULT 0
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (session_id, user_id);

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
    -- Who put this row here, IN THE SORTING KEY. ReplacingMergeTree collapses on the
    -- sorting key, so an imported row and a shipped row sharing (session_id, user_id, seq)
    -- would be the SAME row and the newer ingested_at would win. Measured: 3 imported +
    -- 2 shipped rows became 3, and the two imported ones the shipper overlapped were gone.
    -- A whole import of 135,307 messages once lost 27,948 of them this way.
    origin LowCardinality(String) DEFAULT 'ship',
    -- Which PARSE of the session this row belongs to, also in the sorting key.
    --
    -- The shipper used to DELETE a session's rows before re-inserting them, because a
    -- re-parse that yields fewer messages leaves the old higher-seq rows with nothing
    -- written over them -- a stale tail, and RMT is a dedupe engine, not a diff engine.
    -- That delete destroyed content that existed nowhere else: Claude Code deletes
    -- transcripts after cleanupPeriodDays (30 by default) and COMPACTS them before that,
    -- rewriting a session shorter and different. A shorter re-parse and a fixed adapter
    -- bug are indistinguishable from outside, and the house is supposed to outlive the
    -- source.
    --
    -- So the shipper never overwrites diverging content. When a re-parse is shorter than
    -- what is stored, or any overlapping seq hashes differently, it bumps the epoch and
    -- writes the new parse under it. The old rows keep their epoch, cannot collide with
    -- the new ones, and stay complete. An unchanged re-ship reuses the epoch and dedupes
    -- exactly as before, so the common case costs nothing extra. Insert-only: no DELETE,
    -- no ALTER DELETE grant, no tombstones.
    --
    -- Reads see ONE parse: the read layer resolves this room to the current epoch per
    -- (session_id, user_id) for origin='ship' rows, and leaves every other origin alone
    -- (see house.js roomNames). Without that filter the retained rows would over-count
    -- every rollup -- worse than the stale tail this replaces.
    epoch UInt32 DEFAULT 0,
    user_id String MATERIALIZED currentUser(),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
    text_ngram String MATERIALIZED lower(text),
    text_word  String MATERIALIZED lower(text),
    INDEX idx_text_ngram text_ngram TYPE text(tokenizer = ngrams(3)) GRANULARITY 1,
    INDEX idx_text_word  text_word  TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (session_id, user_id, origin, epoch, seq);

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
    -- Who put this row here, and which parse it belongs to -- both in the sorting key,
    -- for the reasons written out at length on the messages room above. The tool room
    -- shrinks the same way a transcript does: a re-parse with fewer assistant turns emits
    -- fewer tool calls, and the old higher-idx rows have nothing written over them.
    origin LowCardinality(String) DEFAULT 'ship',
    epoch UInt32 DEFAULT 0,
    user_id String MATERIALIZED currentUser(),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (session_id, user_id, origin, epoch, idx);

-- NO sessions_v HERE, deliberately. The session rollup is a SAVED QUERY substituted
-- with these room names and run under the caller's own credential (see rooms.js
-- sessionsRollup). A stored view would need a name inside the `^sessions_` namespace
-- the Merge rooms select on, a fourth grant, and a fourth object to provision and roll
-- forward — for nothing the query does not already do.

-- ─────────────────────────────────────────────────────────────────────────────────
-- The house's own record of itself. Not rooms: nothing about a conversation lives
-- here, and the shipper's guards do not require them (a member on someone else's
-- house may hold no rights to create them, and shipping must not depend on it).
--
-- The house needs these because it now has STATE THE CLIENT CANNOT DERIVE. Sorting
-- keys cannot be altered, so a schema change is a rebuild — and a rebuild has a
-- middle, an actor, and an outcome. "Which version is this house at, is a migration
-- half-done, and who did what" was previously answerable only by reading DDL and
-- guessing.
--
-- Live facts are NOT copied here. Which rooms exist, which users hold which grants,
-- how big each room is: `system.tables`, `system.columns` and `system.users` are
-- authoritative and always current, and a mirror of them would be a second truth that
-- goes stale. What is recorded is what those cannot say: intent, sequence, outcome.

CREATE TABLE IF NOT EXISTS house_meta
(
    -- House-wide keys only ('schema_version', 'house_created_at'). Anything per-member
    -- or per-machine belongs in house_events, which is append-only — this room is
    -- latest-wins, so two members writing one key would overwrite each other.
    key String,
    value String,
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_by String MATERIALIZED currentUser(),
    host LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (key);

CREATE TABLE IF NOT EXISTS house_events
(
    event_at DateTime64(3, 'UTC') DEFAULT now64(3),
    -- 'migration' — a room rebuild, one row per transition (pending → applied|failed)
    -- 'version'   — a memhouse version seen writing to this house, when it changes
    -- 'schema'    — the house's schema version being set or moved
    kind LowCardinality(String),
    id String DEFAULT '',                      -- migration id, e.g. '0100-epoch-key'
    status LowCardinality(String) DEFAULT '',  -- pending | applied | failed | observed
    from_version String DEFAULT '',
    to_version String DEFAULT '',
    actor String MATERIALIZED currentUser(),
    host LowCardinality(String) DEFAULT '',
    rows_before UInt64 DEFAULT 0,
    rows_after UInt64 DEFAULT 0,
    detail String DEFAULT ''
)
-- Plain MergeTree, and nothing ever updates a row: the history IS the table, and the
-- current state of a migration is argMax(status, event_at) over its id. A migration
-- that failed and was retried should read as exactly that, not as a single row whose
-- earlier attempts were overwritten.
ENGINE = MergeTree
ORDER BY (event_at, kind, id);
