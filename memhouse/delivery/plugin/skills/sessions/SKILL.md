---
name: sessions
description: List recent agent sessions from memhouse conversation memory — names, projects, editors, hosts, times, message and token counts across all 17 supported editors. Use for "what was I working on", "show my recent sessions", "sessions from last week", "what did I do in project X", "list my cursor sessions", or to orient before drilling into one session.
user-invocable: true
argument-hint: "[N] [project <name>] [from <editor>] [today|week|month]"
allowed-tools: Bash(set -a*), Bash(. *), Bash(curl*)
---

# /memhouse:sessions — browse session history

List/filter sessions from the session rollup — a saved query over your own rooms, not an
object; `memhouse sessions-query` prints it (session metadata +
message aggregates) in the memhouse house.

## When to use

- The user wants an overview of recent activity rather than a specific quote.
- As a first step before digging into one session, when they don't have an
  id/name yet.

## Connection

**Never print this file or the variables in it.** No `cat "$MH_ENV"`, no `env | grep
MEMHOUSE`, no `set -x` around these commands. Anything you print becomes part of a
transcript that memhouse itself ships into the house.

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

# The credential goes in on STDIN via -K, never in argv. `--user pw` puts the password
# in the process list, in any `set -x` trace, and in whatever the agent's tool output
# captures — and memhouse SHIPS agent transcripts into ClickHouse, where SELECT is the one
# re-grantable privilege. Keep it off the command line.
curl -sS --fail-with-body -K /dev/fd/3 3<<CURLCFG \
  --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-mem}&final=1&join_use_nulls=1&readonly=1" <<'SQL'
user = "$MEMHOUSE_USER:$MEMHOUSE_PASSWORD"
CURLCFG
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
| "which machine did I do the schema work on?" | search via /memhouse:search, or filter `host` here |

## Output

A compact table: when, name (or first prompt), source, host, project, msgs,
tokens. Offer to pull a full transcript next
(`SELECT role, text FROM messages_<you> WHERE session_id = '…' ORDER BY seq`) or to
run /memhouse:search for a specific quote.
