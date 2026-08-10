---
name: sql
description: Run free-form read-only SQL against memhouse conversation memory (typed sessions/messages/tool_calls rooms on ClickHouse, one set per member). Use for ad-hoc analytics the other memhouse skills don't cover — token spend, model/editor usage, tool rankings, activity heatmaps, busiest days/projects, cache-hit ratios, or any custom question over conversation data.
user-invocable: true
argument-hint: "<question or SQL>"
allowed-tools: Bash(set -a*), Bash(. *), Bash(curl*)
---

# /memhouse:sql — ad-hoc analytics

If the user gives SQL, run it (append `FORMAT PrettyCompact` if no FORMAT
given). If they give a question, write the SQL yourself from the schema below.

**Read-only rule:** the shipper (`ship.js`) is the only writer. Never INSERT/ALTER/DROP
from here. A member credential normally holds `ALL` on its **own three rooms** — enough
to destroy that memory — and nothing at all on anyone else's. Reads need no scoping
clause: the rooms you can name are already only yours, and there is no policy to work
around.

The recipe below pins `readonly=1` on every request, so a write that slips past the rule
is refused by the server (`Code: 164 … Cannot execute query in readonly mode`) rather
than by good intentions. Two honest limits: it is a **setting, not a grant** — a caller
who writes their own URL can leave it off — and the HTTP interface refuses
multi-statement bodies, so `SET readonly=0;` cannot be smuggled into a query. For
enforcement that does not depend on this file, the house owner can mint a second
`SELECT`-only credential and point the skills at that instead.

## Connection

Credentials resolve as **flags > exported `MEMHOUSE_*` > `$MEMHOUSE_HOME/env`**
(default `~/.memhouse/env`) — the same order the `memhouse` CLI uses. Every query
runs over ClickHouse HTTP with `final=1` and `join_use_nulls=1` (ReplacingMergeTree
keeps stale row versions until merges; `final=1` collapses to latest-wins — always
include it on reads):

```bash
# Config lives at $MEMHOUSE_HOME/env (default ~/.memhouse/env). Exported MEMHOUSE_*
# vars WIN over the file — snapshot them, source, then put them back. Sourcing alone
# lets a stale file silently override the house you were pointed at.
MH_ENV="${MEMHOUSE_HOME:-$HOME/.memhouse}/env"
_u=${MEMHOUSE_URL-}; _s=${MEMHOUSE_USER-}; _p=${MEMHOUSE_PASSWORD-}; _d=${MEMHOUSE_DB-}
set -a; [ -f "$MH_ENV" ] && . "$MH_ENV"; set +a
[ -n "$_u" ] && MEMHOUSE_URL=$_u; [ -n "$_s" ] && MEMHOUSE_USER=$_s
[ -n "$_p" ] && MEMHOUSE_PASSWORD=$_p; [ -n "$_d" ] && MEMHOUSE_DB=$_d
# No default URL. localhost:8123 as memhouse_root is a REAL house on many machines,
# usually the pilot's own — guessing it reads someone else's memory and looks like it
# worked. If there is no config, say so and stop.
: "${MEMHOUSE_URL:?no memhouse house configured — nothing in $MH_ENV and no MEMHOUSE_URL set. Run: memhouse install}"
: "${MEMHOUSE_USER:?no memhouse house configured — nothing in $MH_ENV and no MEMHOUSE_USER set. Run: memhouse install}"

curl -sS --fail-with-body --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-mem}&final=1&join_use_nulls=1&readonly=1" <<'SQL'
<the query>
FORMAT PrettyCompact
SQL
```

`FORMAT PrettyCompact` for display, `FORMAT JSONEachRow` to parse.

## Room names — always suffixed

Every member owns their own rooms, named for their ClickHouse user:
`messages_<you>`, `sessions_<you>`, `tool_calls_<you>`. There are no unsuffixed rooms;
the bare names fail with `UNKNOWN_TABLE` rather than returning nothing. You hold no grant
on anyone else's rooms, so isolation is not something a query can work around.

Resolve your own name once and substitute it into every table name below:

```bash
MEM_ME="$(curl -sS --fail-with-body --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
  --data-binary "SELECT currentUser() FORMAT TabSeparated" \
  "$MEMHOUSE_URL/" | tr -d '\r\n')"
# rooms: messages_$MEM_ME, sessions_$MEM_ME, tool_calls_$MEM_ME
```

**There is no `sessions_v` object.** The session rollup is a saved query over those same
rooms — `memhouse sessions-query` prints it for whoever you are connected as, ready to
paste into a `FROM (...) AS c` position.

**The rollup is self-contained.** As of 0.4.5 the printed text carries its own `FINAL` on
both rooms and a trailing `SETTINGS join_use_nulls = 1`, so it is correct wherever you
paste it. Both matter: without `FINAL` every message is counted once per undeleted
ReplacingMergeTree version (2x right after a ship, 3x a few ships later — measured, and it
grows); without `join_use_nulls` a session with no messages reports `total_msgs = 1`
rather than 0.

**If the `memhouse` binary is not on PATH**, you cannot print the rollup — the skills are
installable on their own. Query the rooms directly instead: `sessions_<you>` for metadata
and `messages_<you>` for counts, each read `FINAL`, joined on `session_id` and `user_id`.
Prefer the binary when it is there; a rollup you assemble by hand and one printed by a
DIFFERENT memhouse version are the two ways this goes quietly wrong.

If you hold `SELECT` on them, `all_messages` / `all_sessions` / `all_tool_calls` read
across every member at once, narrowed to whatever grants you actually have — a Merge room
reduces to the rooms the caller can read, so it fails closed rather than denying outright.

## Schema (the house)

| Object | Kind | Columns |
|---|---|---|
| `sessions_<you>` | table, 1 row/session | `session_id, source, host, name, mode, folder, project, git_branch, created_at, last_updated_at, message_count, path, extra JSON, user_id, ingested_at` |
| `messages_<you>` | table, 1 row/message | `session_id, seq, source, host, ts, role, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, text, project, folder, is_subagent, extra JSON, line_hash, user_id, ingested_at` + FTS columns `text_ngram`/`text_word` (lowercased; see /memhouse:search) |
| `tool_calls_<you>` | table, 1 row/tool call | `session_id, seq, idx, source, host, tool_name, args, ts, project, folder, user_id, ingested_at` |
| the rollup | **saved query**, not an object — `memhouse sessions-query` prints it | `session_id, source, host, name, mode, folder, project, git_branch, user_id, created_at, last_updated_at, started, ended, duration_sec, total_msgs, user_msgs, assistant_msgs, subagent_msgs, models, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, user_chars, assistant_chars, first_prompt` |

Notes: `source` = editor id (`claude-code`, `codex`, `cursor`, `cursor-agent`,
`vscode`, `zed`, `opencode`, `gemini-cli`, `windsurf`, `antigravity`, …);
`seq` = message index within its session (0-based); `tool_calls.idx` = call
index within the session; `user_id` is server-stamped (`currentUser()`);
`models` in the rollup is an `Array(String)`. Exclude `''` and
`'<synthetic>'` from model aggregates.

## Examples

Token spend by model:

```sql
SELECT model, sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok,
       sum(cache_read_tokens) AS cache_read
FROM messages_<you>
WHERE model NOT IN ('', '<synthetic>')
GROUP BY model
ORDER BY out_tok DESC
FORMAT PrettyCompact
```

Which tools do I use most (memhouse exclusive — memory-house has no tool table):

```sql
SELECT tool_name, count() AS calls, uniqExact(session_id) AS sessions
FROM tool_calls_<you>
GROUP BY tool_name
ORDER BY calls DESC
LIMIT 20
FORMAT PrettyCompact
```

Busiest days, last two weeks:

```sql
SELECT toDate(ts) AS day, uniqExact(session_id) AS sessions, count() AS msgs
FROM messages_<you>
WHERE ts > now() - INTERVAL 14 DAY
GROUP BY day
ORDER BY day DESC
FORMAT PrettyCompact
```

Activity by editor this week / subagent share:

```sql
SELECT source, count() AS msgs, countIf(is_subagent) AS subagent_msgs
FROM messages_<you>
WHERE ts > now() - INTERVAL 7 DAY
GROUP BY source
ORDER BY msgs DESC
FORMAT PrettyCompact
```

Longest sessions by wall-clock:

```sql
SELECT name, project, source, duration_sec, total_msgs, output_tokens
FROM (the rollup from `memhouse sessions-query`)
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
