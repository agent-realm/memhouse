---
name: sql
description: Run free-form read-only SQL against memhouse conversation memory (typed sessions/messages/tool_calls tables on ClickHouse, shared by the house). Use for ad-hoc analytics the other memhouse skills don't cover — token spend, model/editor usage, tool rankings, activity heatmaps, busiest days/projects, cache-hit ratios, or any custom question over conversation data.
user-invocable: true
argument-hint: "<question or SQL>"
allowed-tools: Bash
---

# /mem:sql — ad-hoc analytics

If the user gives SQL, run it (append `FORMAT PrettyCompact` if no FORMAT
given). If they give a question, write the SQL yourself from the schema below.

**Read-only rule:** the shipper (`ship.js`) is the only writer, and it is INSERT-ONLY: it
never deletes and never mutates, because a re-parse that shrank or was rewritten is
written under a new `epoch` instead of over the stored one. Never INSERT/ALTER/DROP from
here. The shipping path needs `SELECT, INSERT, ALTER ADD COLUMN, OPTIMIZE` and nothing
more — the `ALTER DELETE` this line used to list was there for the per-session clear that
no longer exists, so no unattended process can lose you a row. `ALTER DELETE` is still
needed by the one command that is *meant* to remove rows, `memhouse reset`, which asks
first. Most houses grant `ALL` on the database anyway. Reads need no scoping clause: the
house you can name is already yours, and there is no policy to work around.

**One session can be in `messages` twice.** A session that Claude Code compacted, or that
shrank for any other reason, keeps its earlier parse — that is the whole point of `epoch`,
and it is why nothing is ever deleted. Ad-hoc SQL must filter to the current parse or it
counts such a session twice:

```sql
WHERE origin != 'ship'
   OR (session_id, user_id, epoch) IN (
        SELECT session_id, user_id, max(epoch) FROM messages
        WHERE origin = 'ship' GROUP BY session_id, user_id)
```

Drop the filter deliberately when you want the history — "what did this session say before
it was compacted" is a question only the house can answer, because the transcript on disk
is gone.

The recipe below pins `readonly=1` on every request, so a write that slips past the rule
is refused by the server (`Code: 164 … Cannot execute query in readonly mode`) rather
than by good intentions. Two honest limits: it is a **setting, not a grant** — a caller
who writes their own URL can leave it off — and the HTTP interface refuses
multi-statement bodies, so `SET readonly=0;` cannot be smuggled into a query. For
enforcement that does not depend on this file, the house owner can mint a second
`SELECT`-only credential and point the skills at that instead.

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

`FORMAT PrettyCompact` for display, `FORMAT JSONEachRow` to parse.

## Room names — plain, shared tables

The house's rooms are three plain tables: `messages`, `sessions`, `tool_calls` — resolved
by the connection's database (`MEMHOUSE_DB`), not by who is asking. Everyone in the house
writes into the same tables; `user_id` (stamped by the server) says whose row it is and
`host` says which machine shipped it. Filter with `WHERE user_id = '<name>'` when you want
one person, or leave it off for the whole house.

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
installable on their own. Query the rooms directly instead: `sessions` for metadata and
`messages` for counts, each read `FINAL`, joined on `session_id` **and `user_id`** — the
tables are shared, and joining on `session_id` alone can merge two housemates' rows.
Prefer the binary when it is there; a rollup you assemble by hand and one printed by a
DIFFERENT memhouse version are the two ways this goes quietly wrong.

## Schema (the house)

| Object | Kind | Columns |
|---|---|---|
| `sessions` | table, 1 row/session | `session_id, source, host, name, mode, folder, project, git_branch, created_at, last_updated_at, message_count, path, extra JSON, origin, epoch, user_id, ingested_at` |
| `messages` | table, 1 row/message **per parse** | `session_id, seq, source, host, ts, role, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, text, project, folder, is_subagent, extra JSON, line_hash, origin, epoch, user_id, ingested_at` + FTS columns `text_ngram`/`text_word` (lowercased; see /mem:search) |
| `tool_calls` | table, 1 row/tool call **per parse** | `session_id, seq, idx, source, host, tool_name, args, ts, project, folder, origin, epoch, user_id, ingested_at` |
| `house_meta` | table, house's own record | `key, value, updated_at, updated_by, host` — `schema_version`, per-member `client_version:<user>` |
| `house_events` | append-only log | `event_at, kind, id, status, from_version, to_version, actor, host, rows_before, rows_after, detail` — migrations, version changes |
| the rollup | **saved query**, not an object — `memhouse sessions-query` prints it | `session_id, source, host, name, mode, folder, project, git_branch, user_id, created_at, last_updated_at, started, ended, duration_sec, total_msgs, user_msgs, assistant_msgs, subagent_msgs, models, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, user_chars, assistant_chars, first_prompt` |

Notes: `source` = editor id (`claude-code`, `codex`, `cursor`, `cursor-agent`,
`vscode`, `zed`, `opencode`, `gemini-cli`, `windsurf`, `antigravity`, …);
`seq` = message index within its session (0-based); `tool_calls.idx` = call
index within the session; `user_id` is server-stamped (`currentUser()`); `origin` is
`ship` for rows the shipper wrote and anything else for imports; `epoch` is which parse
of the session a row belongs to — see the filter above;
`models` in the rollup is an `Array(String)`. Exclude `''` and
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

Which tools do I use most (memhouse exclusive — memory-house has no tool table):

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
