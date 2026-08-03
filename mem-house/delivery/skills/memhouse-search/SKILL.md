---
name: memhouse-search
description: Full-text search across ALL shipped agent conversations — every session from all 17 supported editors (Claude Code, Codex, Cursor, VS Code, Zed, OpenCode, Gemini CLI, …), every project, every machine — stored in the memhouse ClickHouse. Use whenever the user refers to something from the past that isn't in the current context, e.g. "what did I say about X", "find that conversation about Y", "when did I work on Z", "did I ever try W", "the chat where we discussed it", "remind me how I did it". Reach for this before saying you don't know about prior work.
user-invocable: true
argument-hint: "<search terms> [in <project>] [last <N> days] [from <editor>]"
allowed-tools: Bash(set -a*), Bash(. *), Bash(curl*)
---

# memhouse-search — search conversation memory

Search the full message history in the memhouse house (`messages` + `sessions`
tables on ClickHouse).

## Connection

Credentials come from `~/.memhouse/env` (or already-exported `MEMHOUSE_*` vars).
Every query runs over ClickHouse HTTP with `final=1` and `join_use_nulls=1`
(ReplacingMergeTree keeps stale row versions until merges; `final=1` collapses to
latest-wins — always
include it on reads):

```bash
set -a; [ -f ~/.memhouse/env ] && . ~/.memhouse/env; set +a
curl -sS --fail-with-body --user "${MEMHOUSE_USER:-memhouse_root}:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "${MEMHOUSE_URL:-http://localhost:8123}/?database=${MEMHOUSE_DB:-memhouse}&final=1&join_use_nulls=1" <<'SQL'
<the query>
FORMAT PrettyCompact
SQL
```

`FORMAT PrettyCompact` for display; `FORMAT JSONEachRow` when you want to parse
the rows yourself.

## Room names

Two layouts exist, and the table names differ between them. `~/.memhouse/env` says
which one this house uses:

- `MEM_PER_MEMBER` unset or `0` — shared rooms. Use the names below as written.
- `MEM_PER_MEMBER=1` — every member has their own rooms, named for their ClickHouse
  user: `messages_alice`, `sessions_alice`, `tool_calls_alice`. A member holds no grant
  on anyone else's, so the unsuffixed names below do not merely return nothing — they
  fail with `UNKNOWN_TABLE`.
  **There is no `sessions_v` in this layout.** The session rollup is a saved query over
  those same rooms, not a stored object; `memhouse sessions-query` prints it for whoever
  you are connected as, ready to paste into a `FROM (...) AS c` position.

Resolve the suffix once, then substitute it into every table name:

```bash
MEM_SUFFIX=""
if [ "${MEM_PER_MEMBER:-0}" = "1" ]; then
  MEM_SUFFIX="_$(curl -sS --fail-with-body --user "$MEMHOUSE_USER:$MEMHOUSE_PASSWORD" \
    --data-binary "SELECT currentUser() FORMAT TabSeparated" \
    "${MEMHOUSE_URL:-http://localhost:8123}/" | tr -d '\r\n')"
fi
# rooms: messages${MEM_SUFFIX}, sessions${MEM_SUFFIX}, tool_calls${MEM_SUFFIX}
# rollup: `sessions_v` in the shared layout; `$(memhouse sessions-query)` per-member
```

**Whichever rollup you use, read with `join_use_nulls=1`.** The connection recipe above
already sets it. Without it, ClickHouse's default outer-join behaviour gives an
unmatched `m.seq` a default value instead of NULL, so a session with no messages reports
`total_msgs = 1` rather than 0 — measured, not theoretical. The shared `sessions_v` view
carries the setting internally; the per-member saved query cannot, because a subquery has
no `SETTINGS` clause of its own.

## How to search (the FTS columns)

`messages` carries two MATERIALIZED lowercase copies of `text`, each with a
text index — search those, display `text`:

- `text_ngram` (ngram index) → substring match: `text_ngram LIKE '%term%'`
- `text_word` (word index) → whole-token match: `hasToken(text_word, 'term')`

**Search terms MUST be lowercased** (the columns are `lower(text)`); escape
single quotes in user terms as `\'`. Multiple words → AND of clauses; a quoted
phrase → one `LIKE` clause for the whole phrase.

### Example 1 — substring search with session names

```sql
SELECT m.ts, m.source, m.project, m.role, m.session_id,
       s.name AS session,
       substring(m.text, 1, 300) AS snippet
FROM messages AS m
LEFT JOIN sessions AS s USING (session_id)
WHERE m.text_ngram LIKE '%postgres%' AND m.text_ngram LIKE '%migration%'
ORDER BY m.ts DESC
LIMIT 30
FORMAT PrettyCompact
```

### Example 2 — word match, scoped by editor and time

```sql
SELECT ts, project, session_id, substring(text, 1, 200) AS snippet
FROM messages
WHERE hasToken(text_word, 'rls')
  AND source = 'claude-code'
  AND ts > now() - INTERVAL 14 DAY
ORDER BY ts DESC
LIMIT 20
FORMAT PrettyCompact
```

### Example 3 — which sessions mention it most (then drill in)

```sql
SELECT m.session_id, any(s.name) AS session, any(m.project) AS project,
       count() AS hits, max(m.ts) AS last_hit
FROM messages AS m
LEFT JOIN sessions AS s USING (session_id)
WHERE m.text_ngram LIKE '%clickhouse cache%'
GROUP BY m.session_id
ORDER BY hits DESC
LIMIT 10
FORMAT PrettyCompact
```

## Qualifiers

- `in <project>` → `AND m.project ILIKE '%<project>%'`
- `last N days` → `AND m.ts > now() - INTERVAL N DAY`
- `from <editor>` → `AND m.source = '<id>'` (ids: `claude-code`, `codex`,
  `cursor`, `cursor-agent`, `vscode`, `zed`, `opencode`, `gemini-cli`,
  `windsurf`, `antigravity`, `copilot-cli`, `goose`, `kiro`, …)
- Skip subagent noise → `AND NOT m.is_subagent`
- Only user/assistant text lives in `messages`; tool invocations are in
  `tool_calls` (`tool_name`, `args`) — search `args ILIKE '%term%'` there only
  if the user explicitly wants tool calls searched.

## Output

Summarize hits grouped by session (name, source, project, date, 1–2 best
snippets each) and give the total hit count. Offer to pull the full transcript
of the best session (`SELECT role, text FROM messages WHERE session_id = '…'
ORDER BY seq`). If zero hits, retry with broader/fewer terms and report the
corpus size (`SELECT count() FROM messages`).
