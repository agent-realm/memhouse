---
name: memhouse-sessions
description: List recent agent sessions from memhouse conversation memory — names, projects, editors, hosts, times, message and token counts across all 17 supported editors. Use for "what was I working on", "show my recent sessions", "sessions from last week", "what did I do in project X", "list my cursor sessions", or to orient before drilling into one session.
user-invocable: true
argument-hint: "[N] [project <name>] [from <editor>] [today|week|month]"
allowed-tools: Bash(set -a*), Bash(. *), Bash(curl*)
---

# memhouse-sessions — browse session history

List/filter sessions from the `sessions_v` rollup view (session metadata +
message aggregates) in the memhouse house.

## When to use

- The user wants an overview of recent activity rather than a specific quote.
- As a first step before digging into one session, when they don't have an
  id/name yet.

## Connection

Credentials from `~/.memhouse/env` (or exported `MEMHOUSE_*`). Always read with
`final=1` (collapses ReplacingMergeTree duplicates to latest-wins) and
`join_use_nulls=1` (see below — the session rollup needs it):

```bash
set -a; [ -f ~/.memhouse/env ] && . ~/.memhouse/env; set +a
curl -sS --fail-with-body --user "${MEMHOUSE_USER:-memhouse_root}:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "${MEMHOUSE_URL:-http://localhost:8123}/?database=${MEMHOUSE_DB:-mem}&final=1&join_use_nulls=1" <<'SQL'
<the query>
FORMAT PrettyCompact
SQL
```

## Room names — always suffixed

Every member owns their own rooms, named for their ClickHouse user:
`messages_<you>`, `sessions_<you>`, `tool_calls_<you>`. There are no unsuffixed rooms;
the bare names fail with `UNKNOWN_TABLE` rather than returning nothing. You hold no grant
on anyone else's rooms, so isolation is not something a query can work around.

Resolve your own name once and substitute it into every table name below:

```bash
MEM_ME="$(curl -sS --fail-with-body --user "$MEMHOUSE_USER:$MEMHOUSE_PASSWORD" \
  --data-binary "SELECT currentUser() FORMAT TabSeparated" \
  "${MEMHOUSE_URL:-http://localhost:8123}/" | tr -d '\r\n')"
# rooms: messages_$MEM_ME, sessions_$MEM_ME, tool_calls_$MEM_ME
```

**There is no `sessions_v` object.** The session rollup is a saved query over those same
rooms — `memhouse sessions-query` prints it for whoever you are connected as, ready to
paste into a `FROM (...) AS c` position.

**Read the rollup with `join_use_nulls=1`.** The connection recipe above sets it. Without
it, ClickHouse gives an unmatched `m.seq` a default instead of NULL, so a session with no
messages reports `total_msgs = 1` rather than 0 — measured, not theoretical. A subquery
has no `SETTINGS` clause of its own, so the setting has to come from the caller.

If you hold `SELECT` on them, `all_messages` / `all_sessions` / `all_tool_calls` read
across every member at once, narrowed to whatever grants you actually have — a Merge room
reduces to the rooms the caller can read, so it fails closed rather than denying outright.

## Default listing

```sql
SELECT session_id, name, source, host, project,
       started, ended, total_msgs, user_msgs, assistant_msgs,
       output_tokens,
       substring(first_prompt, 1, 80) AS first_prompt
FROM (the rollup from `memhouse sessions-query`)
ORDER BY ended DESC
LIMIT 20
FORMAT PrettyCompact
```

- Default `LIMIT 20`; `[N]` overrides.
- `today` / `week` / `month` → `WHERE ended > now() - INTERVAL 1 DAY`
  (`7 DAY` / `30 DAY`).
- `project <name>` → `WHERE project ILIKE '%<name>%'`.
- `from <editor>` → `WHERE source = '<id>'` (`claude-code`, `codex`, `cursor`,
  `vscode`, `zed`, `opencode`, `gemini-cli`, `windsurf`, …).
- Unnamed sessions (`name = ''`): fall back to `first_prompt` as the label.

## More cuts

Per-editor rollup ("where has my work been happening?"):

```sql
SELECT source, count() AS sessions, sum(total_msgs) AS msgs,
       sum(output_tokens) AS out_tokens, max(ended) AS last_activity
FROM (the rollup from `memhouse sessions-query`)
GROUP BY source
ORDER BY sessions DESC
FORMAT PrettyCompact
```

Busiest projects this month:

```sql
SELECT project, count() AS sessions, sum(assistant_msgs) AS assistant_msgs
FROM (the rollup from `memhouse sessions-query`)
WHERE ended > now() - INTERVAL 30 DAY AND project != ''
GROUP BY project
ORDER BY sessions DESC
LIMIT 15
FORMAT PrettyCompact
```

## Examples

| User says | What you do |
|---|---|
| "what was I working on yesterday?" | `WHERE ended > now() - INTERVAL 1 DAY` |
| "show my last 10 sessions in agentlytics" | `LIMIT 10 … WHERE project ILIKE '%agentlytics%'` |
| "list my cursor sessions this month" | `WHERE source = 'cursor' AND ended > now() - INTERVAL 30 DAY` |
| "which machine did I do the schema work on?" | search via memhouse-search, or filter `host` here |

## Output

A compact table: when, name (or first prompt), source, host, project, msgs,
tokens. Offer to pull a full transcript next
(`SELECT role, text FROM messages_<you> WHERE session_id = '…' ORDER BY seq`) or to
run memhouse-search for a specific quote.
