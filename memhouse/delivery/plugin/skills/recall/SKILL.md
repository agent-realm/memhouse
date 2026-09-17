---
name: recall
description: Retrieve from past agent conversations and answer from them — search every session ever shipped from all 17 editors (Claude Code, Codex, Cursor, VS Code, Zed, Gemini CLI, …) across every project and machine, read the actual transcripts, and answer with citations. Use whenever the user refers to something not in the current context - "how did I fix X last time", "what approach did we settle on", "why did we choose Z", "find that conversation about Y", "did I ever try W", "what was I working on", "show my recent sessions", "sessions from last week", "remind me how I did it". Reach for this BEFORE saying you do not know about prior work. Also reads a housemate's memory when they name it ("how did yigit fix X"). For numbers rather than transcripts — spend, model mix, tool rankings — use /mem:sql.
user-invocable: true
argument-hint: "<question, terms, or 'recent sessions'>"
allowed-tools: Bash
---

# /mem:recall — find it, read it, answer from it

The house is the archive that OUTLIVES the transcripts on disk. Claude Code compacts and
deletes local sessions, so for anything older than ~30 days this is the only place the
answer still exists.

**The synthesis is yours; the store is not.** memhouse runs no LLM in its write or read
path — this skill retrieves rows and YOU read them. Never present a guess as a retrieval:
if the house has nothing, say so.

**Read `../reference/HOUSE.md` first** — connection, schema, and the three traps
(epoch filtering, `(session_id, user_id)` joins, escaping). Every query below assumes it.

## Which shape is being asked for

One skill, three depths. Pick by what the user wants back, not by which words they used.

- **A question** ("how did I fix X") → retrieve, read the turns, answer with citations.
- **A conversation** ("find the chat about Y") → locate sessions, describe them, offer
  to read one.
- **An orientation** ("what was I working on") → list recent sessions and stop.

When it is ambiguous, do the deepest one that fits — an answer with citations also tells
them which session it was, whereas a bare list does not answer anything.

## Answering a question

**1. Extract terms that would appear in the ANSWER, not the question.** "How did I fix
the ClickHouse auth error?" → `ClickHouse auth`, `Authentication failed`, `ACCESS_DENIED`.
Error strings beat paraphrases; identifiers beat prose. Run 2–3 variants — and search
each term SEPARATELY, because the columns hold text, not concepts: a needle of
`clickhouse ttl` matches only that exact adjacency. On a real house `%clickhouse ttl%`
found 8 messages where `%clickhouse%` AND `%ttl%` found 1,461.

```sql
SELECT session_id, user_id, any(folder) AS folder,
       formatDateTime(max(ts), '%Y-%m-%d') AS day, count() AS hits,
       substring(anyIf(text, positionCaseInsensitive(text, 'NEEDLE') > 0), 1, 300) AS sample
FROM messages
WHERE text_ngram LIKE '%needle%'
  AND (origin != 'ship'
       OR (session_id, user_id, epoch) IN (
            SELECT session_id, user_id, max(epoch) FROM messages
            WHERE origin = 'ship' GROUP BY session_id, user_id))
GROUP BY session_id, user_id
ORDER BY hits DESC, max(ts) DESC
LIMIT 8
```

`anyIf(...)` so the sample is a line that actually matched — `any(text)` returns an
arbitrary message from the session and misled two readers in three. **Order by `hits`,
not just recency**: a session mentioning the term 197 times outranks yesterday's passing
reference.

**2. Read the strongest sessions — the turns, not the hit line.** Pull a window around
the match so you see the resolution, not the complaint:

```sql
SELECT seq, role, substring(text, 1, 2000) AS text
FROM messages
WHERE session_id = '<sid>' AND user_id = '<uid>'
  AND seq BETWEEN <hit_seq - 3> AND <hit_seq + 12>
ORDER BY seq
```

Apply the epoch filter here too — an unfiltered read of a compacted session interleaves
two parses of the same conversation.

**3. Answer, then cite.** Lead with the answer. Under it list the sessions it came from —
`session_id`, date, project — so the user can reopen one (`memhouse resume <session_id>`
prints the command). Quote decisive lines verbatim where exact wording matters: an error
string, a command, a config value.

**4. Nothing found is an answer.** Say what you searched and where coverage ends
(`SELECT min(ts), max(ts), count() FROM messages`) rather than padding. Check the obvious
causes first: wrong case (the columns are lowercased), a phrase that never occurred
adjacently, or a house that simply has not shipped that project.

## Finding a conversation

Same first query, then describe what you found — project, editor, date, how many hits,
one representative line each. Offer to read the strongest. Do not dump ten rows and stop.

## Listing recent sessions

`memhouse sessions-query` prints a self-contained rollup (it carries its own `FINAL`);
prefer it over hand-joining. For a plain list:

```sql
SELECT session_id, name, source, host, project,
       formatDateTime(started_at, '%Y-%m-%d %H:%i') AS started, message_count
FROM sessions
ORDER BY started_at DESC
LIMIT 20
```

Narrow with `WHERE project = '…'`, `source = 'cursor'`, `host = '…'`, or a date range as
asked. In a shared house every member's sessions are here — add `AND user_id = '<name>'`
only when the user asks for one person's.

## What can bite

Beyond the three in the reference:

- **Ranking is yours.** There is no relevance score in the store. `hits` plus recency is
  the whole of it — say so rather than implying the top row is "the best match".
- **A subagent (fork) is not a session.** Its turns are inside the parent session with
  `is_subagent = 1` and `extra.agent.id` / `extra.agent.description` saying which one; the
  reference has the two queries. "Find the fork that did X" → search `messages` as usual,
  then group the hits by `toString(extra.agent.id)` — never conclude it was not shipped because no
  session carries its name.
- **Tool *results* are not stored.** "What did that command print" is unanswerable from
  the house; only the invocation and its arguments survive.
- **`memhouse search`** exists as a CLI, but it joins your terms into ONE literal phrase
  and orders by date alone. Prefer the SQL above; reach for the CLI only for a quick
  one-word look.
