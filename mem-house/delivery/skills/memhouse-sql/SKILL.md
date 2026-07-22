---
name: memhouse-sql
description: Run free-form read-only SQL against mem-house conversation memory (typed sessions/messages/tool_calls tables + the sessions_v view on ClickHouse). Use for ad-hoc analytics the other memhouse skills don't cover — token spend, model/editor usage, tool rankings, activity heatmaps, busiest days/projects, cache-hit ratios, or any custom question over conversation data.
user-invocable: true
argument-hint: "<question or SQL>"
allowed-tools: Bash(set -a*), Bash(. *), Bash(curl*)
---

# memhouse-sql — ad-hoc analytics

If the user gives SQL, run it (append `FORMAT PrettyCompact` if no FORMAT
given). If they give a question, write the SQL yourself from the schema below.

**Read-only rule:** the shipper (`ship.js`) is the only writer. Never INSERT/
ALTER/DROP from here — member credentials typically hold only
`INSERT, SELECT ON memhouse.*`, and on shared instances own-only row policies
scope reads to your rows.

## Connection

Credentials from `~/.memhouse/env` (or exported `MEMHOUSE_*`). Always read with
`final=1` — every table is `ReplacingMergeTree(ingested_at)`, so without it you
can double-count stale row versions:

```bash
set -a; [ -f ~/.memhouse/env ] && . ~/.memhouse/env; set +a
curl -sS --fail-with-body --user "${MEMHOUSE_USER:-memhouse_root}:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "${MEMHOUSE_URL:-http://localhost:8123}/?database=${MEMHOUSE_DB:-memhouse}&final=1" <<'SQL'
<the query>
FORMAT PrettyCompact
SQL
```

`FORMAT PrettyCompact` for display, `FORMAT JSONEachRow` to parse.

## Schema (the house)

| Object | Kind | Columns |
|---|---|---|
| `sessions` | table, 1 row/session | `session_id, source, host, name, mode, folder, project, git_branch, created_at, last_updated_at, message_count, path, extra JSON, user_id, ingested_at` |
| `messages` | table, 1 row/message | `session_id, seq, source, host, ts, role, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, text, project, folder, is_subagent, extra JSON, line_hash, user_id, ingested_at` + FTS columns `text_ngram`/`text_word` (lowercased; see memhouse-search) |
| `tool_calls` | table, 1 row/tool call | `session_id, seq, idx, source, host, tool_name, args, ts, project, folder, user_id, ingested_at` |
| `sessions_v` | view, rollup | `session_id, source, host, name, mode, folder, project, git_branch, user_id, created_at, last_updated_at, started, ended, duration_sec, total_msgs, user_msgs, assistant_msgs, subagent_msgs, models, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, user_chars, assistant_chars, first_prompt` |

Notes: `source` = editor id (`claude-code`, `codex`, `cursor`, `cursor-agent`,
`vscode`, `zed`, `opencode`, `gemini-cli`, `windsurf`, `antigravity`, …);
`seq` = message index within its session (0-based); `tool_calls.idx` = call
index within the session; `user_id` is server-stamped (`currentUser()`);
`models` in `sessions_v` is an `Array(String)`. Exclude `''` and
`'<synthetic>'` from model aggregates.

## Examples

Token spend by model:

```sql
SELECT model, sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok,
       sum(cache_read_tokens) AS cache_read
FROM messages
WHERE model NOT IN ('', '<synthetic>')
GROUP BY model
ORDER BY out_tok DESC
FORMAT PrettyCompact
```

Which tools do I use most (mem-house exclusive — memory-house has no tool table):

```sql
SELECT tool_name, count() AS calls, uniqExact(session_id) AS sessions
FROM tool_calls
GROUP BY tool_name
ORDER BY calls DESC
LIMIT 20
FORMAT PrettyCompact
```

Busiest days, last two weeks:

```sql
SELECT toDate(ts) AS day, uniqExact(session_id) AS sessions, count() AS msgs
FROM messages
WHERE ts > now() - INTERVAL 14 DAY
GROUP BY day
ORDER BY day DESC
FORMAT PrettyCompact
```

Activity by editor this week / subagent share:

```sql
SELECT source, count() AS msgs, countIf(is_subagent) AS subagent_msgs
FROM messages
WHERE ts > now() - INTERVAL 7 DAY
GROUP BY source
ORDER BY msgs DESC
FORMAT PrettyCompact
```

Longest sessions by wall-clock:

```sql
SELECT name, project, source, duration_sec, total_msgs, output_tokens
FROM sessions_v
ORDER BY duration_sec DESC
LIMIT 10
FORMAT PrettyCompact
```

## Output

Run the query, present the result as a compact table, and add one or two lines
of interpretation. Offer a natural follow-up cut (by source, by project, by
host, by token volume) when relevant. Dollar costs are computed by the
dashboard server from pricing.js — token sums here are the raw material, not
dollars.
