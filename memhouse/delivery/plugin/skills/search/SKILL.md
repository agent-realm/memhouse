---
name: search
description: Full-text search across ALL shipped agent conversations — every session from all 17 supported editors (Claude Code, Codex, Cursor, VS Code, Zed, OpenCode, Gemini CLI, …), every project, every machine — stored in the memhouse ClickHouse. Use whenever the user refers to something from the past that isn't in the current context, e.g. "what did I say about X", "find that conversation about Y", "when did I work on Z", "did I ever try W", "the chat where we discussed it", "remind me how I did it". Searches your own house by default, or a friend's house shared with you when they name it ("find X in yigit's memory"). Reach for this before saying you don't know about prior work.
user-invocable: true
argument-hint: "<search terms> [in <project>] [last <N> days] [from <editor>]"
allowed-tools: Bash
---

# /mem:search — search conversation memory

Search the full message history in the memhouse house. Every room is named for your
ClickHouse user — `messages`, `sessions` — see **Room names** below.

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

`FORMAT PrettyCompact` for display; `FORMAT JSONEachRow` when you want to parse
the rows yourself.

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
paste it. `final=1` on the connection still matters for reads of the rooms THEMSELVES,
which carry no FINAL of their own.


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
LEFT JOIN sessions AS s USING (session_id, user_id)
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
SELECT m.session_id, m.user_id, any(s.name) AS session, any(m.project) AS project,
       count() AS hits, max(m.ts) AS last_hit
FROM messages AS m
LEFT JOIN sessions AS s USING (session_id, user_id)
WHERE m.text_ngram LIKE '%clickhouse cache%'
GROUP BY m.session_id, m.user_id
ORDER BY hits DESC
LIMIT 10
FORMAT PrettyCompact
```

## Reading another person's house (shared with you)

Every house is its own ClickHouse database on the same server; a share is a read-only
GRANT on that database. To read a friend's memory you keep YOUR credentials and point the
connection at THEIR house — the rooms (`messages`, `sessions`, `tool_calls`) resolve by
the connection's `database`, so one change redirects every query in this skill.

1. **Resolve the target house.** `SHOW DATABASES` lists what your credential may read; the
   names that are not `system` / `information_schema` / `default` and not your own
   `$MEMHOUSE_DB` are houses shared with you. If the user names one — "yigit's memory",
   "in yigit", "house yigit", "from yigit" — set `HOUSE=yigit`; otherwise leave
   `HOUSE=$MEMHOUSE_DB`.
2. **Point the connection at it:** in the recipe above, replace
   `database=${MEMHOUSE_DB:-mem}` with `database=<HOUSE>`. Leave the table names bare —
   they resolve to that house. Nothing else in the query changes.
3. **A house wins over `in <project>`.** A name that matches a readable house is a HOUSE,
   not a project filter — otherwise "in yigit" silently filters YOUR house's project
   column and returns nothing. If a real project in your own house shares the name, keep
   the possessive ("<name>'s memory") or say "project <name>" to force the project reading.
4. **Read-only, thin by design.** If the SELECT is refused, that house was not shared with
   you (or the share was revoked) — say so; never guess another database.

## Qualifiers

- `in <project>` → `AND m.project ILIKE '%<project>%'` — but a name matching a readable
  house is a HOUSE (see above), not a project.
- `last N days` → `AND m.ts > now() - INTERVAL N DAY`
- `from <editor>` → `AND m.source = '<id>'` (ids: `claude-code`, `codex`,
  `cursor`, `cursor-agent`, `vscode`, `zed`, `opencode`, `gemini-cli`,
  `windsurf`, `antigravity`, `copilot-cli`, `goose`, `kiro`, …)
- Skip subagent noise → `AND NOT m.is_subagent`
- Only user/assistant text lives in `messages`; tool invocations are in
  `tool_calls` (`tool_name`, `args`) — search `args ILIKE '%term%'` there
  only if the user explicitly wants tool calls searched.

## Output

Summarize hits grouped by session (name, source, project, date, 1–2 best
snippets each) and give the total hit count. Offer to pull the full transcript
of the best session (`SELECT role, text FROM messages WHERE session_id = '…'
ORDER BY seq`). If zero hits, retry with broader/fewer terms and report the
corpus size (`SELECT count() FROM messages`).
