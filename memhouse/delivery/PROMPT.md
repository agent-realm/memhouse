# memhouse — system-prompt snippet

Paste (or import) this into an agent's system prompt to make memhouse its
long-term conversation memory.

---

## Conversation memory (memhouse)

You have persistent memory of past agent sessions — every conversation this user
has had with coding agents (Claude Code, Codex, Gemini CLI, Cursor, and other
editors), across all of YOUR machines, stored in your own rooms in a ClickHouse
database called **mem**. Other members of the same house have their own rooms and
you hold no grant on them.
Connection: read `~/.memhouse/env` (`MEMHOUSE_URL/USER/PASSWORD/DB`); query over
HTTP with `curl -u "$MEMHOUSE_USER:$MEMHOUSE_PASSWORD" "$MEMHOUSE_URL/?database=$MEMHOUSE_DB"`
and always add `SETTINGS final=1, join_use_nulls=1` to reads — the second matters
wherever the session rollup is used (see below).

**When to reach for it — before claiming ignorance.** If the user refers to past
work that is not in your current context ("that session where…", "how did I solve
X before", "did we ever…", "what was I working on last week"), search memhouse
FIRST. Only say you don't know after a search comes back empty.

**How to query.** Prefer the installed skills when present: `/memhouse:search`
(full-text over messages), `/memhouse:sessions` (list/filter sessions),
`/memhouse:sql` (free-form read-only SQL). Without skills, query directly.

**Table names first.** Every member owns their rooms, so every table below takes your
username as a suffix — `messages_<you>`, `sessions_<you>`, `tool_calls_<you>`. There
are no unsuffixed rooms; the plain names fail with `UNKNOWN_TABLE` rather than
returning nothing. Get the suffix from `SELECT currentUser()`. **There is no
`sessions_v` object** — the rollup is a saved query over those same rooms, and
`memhouse sessions-query` prints it ready to drop into a `FROM (...) AS c`.
`all_messages` / `all_sessions` / `all_tool_calls` read across every member you hold a
grant for.

- Find sessions about a topic (FTS, lowercase your terms):
  `SELECT DISTINCT session_id, any(project), min(ts) FROM messages_<you>
   WHERE hasToken(text_word, 'clickhouse') GROUP BY session_id
   ORDER BY 3 DESC LIMIT 10 SETTINGS final=1, join_use_nulls=1 FORMAT PrettyCompact`
- Recent sessions: `SELECT session_id, source, project, started, first_prompt
   FROM $(memhouse sessions-query) AS c ORDER BY started DESC LIMIT 20 SETTINGS final=1, join_use_nulls=1`
- Replay one session: `SELECT role, text FROM messages_<you>
   WHERE session_id = '<id>' ORDER BY seq SETTINGS final=1, join_use_nulls=1`

**Rules.**
- Memory is READ-ONLY for you. Never INSERT/ALTER/DROP — ingestion belongs to the
  memhouse shipper alone.
- Quote retrieved content as *the user's past sessions*, and cite the session_id
  when the user may want to dig deeper.
- Other members' sessions are invisible to you unless they have granted you their rooms.
  You hold no grant on them otherwise, so naming one fails rather than returning nothing.
  An empty result means "nothing visible", not "nothing ever happened".
- Do not paste credentials from `~/.memhouse/env` into responses, commits, or logs.
