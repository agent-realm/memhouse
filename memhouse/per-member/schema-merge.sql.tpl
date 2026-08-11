-- mem — the Merge rooms. Owner-managed, created once per house.
--
-- Team-wide reads. Each is a regex over room names anchored on the ROOM TYPE, so it
-- matches member rooms only and can never match itself (`^messages_` does not match
-- `all_messages`).
--
-- Three measured properties this relies on (ClickHouse 26.7.1):
--   * fails closed on permissions — a caller sees only the underlying rooms they hold
--     grants for, with no leak and no error, so these can be granted broadly —
--   * auto-discovers rooms created after them, so member onboarding needs no DDL here —
--   * tolerates schema drift, returning a column's default for rooms lacking it — which
--     is what makes schema rollout progressive. Merge REJECTS mutations, so a new column
--     is added with ADD COLUMN, on the Merge room FIRST.
--
-- {{TEMPLATE_MEMBER}} is any existing member — the Merge room borrows its column list.

CREATE TABLE IF NOT EXISTS all_sessions AS sessions_{{TEMPLATE_MEMBER}}
ENGINE = Merge(currentDatabase(), '^sessions_');

CREATE TABLE IF NOT EXISTS all_messages AS messages_{{TEMPLATE_MEMBER}}
ENGINE = Merge(currentDatabase(), '^messages_');

CREATE TABLE IF NOT EXISTS all_tool_calls AS tool_calls_{{TEMPLATE_MEMBER}}
ENGINE = Merge(currentDatabase(), '^tool_calls_');
