---
name: sessions
description: List recent agent sessions from memhouse conversation memory — names, projects, editors, hosts, times, message and token counts across all 17 supported editors. Use for "what was I working on", "show my recent sessions", "sessions from last week", "what did I do in project X", "list my cursor sessions", or to orient before drilling into one session.
user-invocable: true
argument-hint: "[N] [project <name>] [from <editor>] [today|week|month]"
allowed-tools: Bash
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
if [ -z "${MEMHOUSE_URL:-}" ] || [ -z "${MEMHOUSE_USER:-}" ]; then
  # An explicit test, not ${VAR:?msg}: zsh does not expand the message, so under the
  # shell Claude Code actually uses the refusal read "nothing in $MH_ENV" literally.
  echo "no memhouse house configured — nothing in $MH_ENV and no MEMHOUSE_URL/MEMHOUSE_USER set." >&2
  echo "Run: memhouse install" >&2
  exit 1
fi

# --user, not a -K config file. The config-file parser treats `"` and `\` specially, so a
# password containing either authenticates fine from the CLI and fails from every skill
# with "password is incorrect" — measured. The argv exposure -K was meant to avoid is not
# observable here either: curl blanks the --user argument before `ps` can read it (0 hits
# in 50 samples). What actually leaks a credential is PRINTING it, which the rule above
# covers.
curl -sS --fail-with-body --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-mem}&final=1&join_use_nulls=1&readonly=1" <<'SQL'
<the query>
FORMAT PrettyCompact
SQL
```

## Room names — plain, shared tables

The house's rooms are three plain tables: `messages`, `sessions`, `tool_calls` — resolved
by the connection's database (`MEMHOUSE_DB`), not by who is asking. Everyone in the house
writes into the same tables; `user_id` (stamped by the server) says whose row it is and
`host` says which machine shipped it. Search the whole house by default; add
`AND user_id = '<name>'` only when the user asks for one person's sessions.

**Keep the SQL heredoc quoted (`<<'SQL'`).** This skill once told the agent to substitute
a shell variable into the table names, which cannot expand inside a quoted heredoc — so
the agent unquotes it, and then the SEARCH TERMS expand too. Both instances driving this
skill did exactly that, unprompted, on the first attempt. Measured consequences, from
`system.query_log`:

- a term containing `$home` became the empty string, so `LIKE '%%'` matched **every row**
  and reported hits with exit 0 — silently wrong, not an error;
- a term containing a backtick **executed the command inside it**.

A user's search term is arbitrary text. With the heredoc quoted, neither can happen.

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
installable on their own. Query the rooms directly instead: `sessions` for metadata
and `messages` for counts, each read `FINAL`, joined on `session_id` and `user_id`.
Prefer the binary when it is there; a rollup you assemble by hand and one printed by a
DIFFERENT memhouse version are the two ways this goes quietly wrong.


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
(`SELECT role, text FROM messages WHERE session_id = '…' ORDER BY seq`) or to
run /memhouse:search for a specific quote.
