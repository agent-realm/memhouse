---
name: ask
description: Answer a question FROM conversation memory — retrieve the relevant past sessions out of the memhouse ClickHouse store, read the actual transcripts, and synthesize an answer with citations. Use when the user asks something their past work already answered, e.g. "how did I fix X last time", "what approach did we settle on for Y", "why did we choose Z", "have I solved this error before", "what did the reviewer say about W". Also answers from a friend's house shared with you when they name it ("how did yigit fix X", "ask yigit's memory"). This is the retrieve-and-answer skill; /mem:search is find-the-session, /mem:sql is run-a-query.
user-invocable: true
argument-hint: "<question about past work>"
allowed-tools: Bash
---

# /mem:ask — answer from conversation memory

Answer the user's question from what the house holds, not from what you assume. The
house is the archive that OUTLIVES the transcripts on disk — Claude Code compacts and
deletes local session files, so for anything older than ~30 days memhouse is the only
place the answer still exists.

The synthesis is yours; the store is not. memhouse itself runs no LLM anywhere in its
write or read path — this skill retrieves rows and YOU read them. Never present a guess
as a retrieval: if the house has nothing on the question, say so.

## Connection

**Never print this file or the variables in it.** No `cat "$MH_ENV"`, no `env | grep
MEMHOUSE`, no `set -x` around these commands. Anything you print becomes part of a
transcript that memhouse itself ships into the house.

Credentials resolve as **flags > exported `MEMHOUSE_*` > `$MEMHOUSE_HOME/env`**
(default `~/.memhouse/env`) — the same order the `memhouse` CLI uses:

```bash
MH_ENV="${MEMHOUSE_HOME:-$HOME/.memhouse}/env"
_u=${MEMHOUSE_URL-}; _s=${MEMHOUSE_USER-}; _p=${MEMHOUSE_PASSWORD-}; _d=${MEMHOUSE_DB-}
set -a; [ -f "$MH_ENV" ] && . "$MH_ENV"; set +a
[ -n "$_u" ] && MEMHOUSE_URL=$_u; [ -n "$_s" ] && MEMHOUSE_USER=$_s
[ -n "$_p" ] && MEMHOUSE_PASSWORD=$_p; [ -n "$_d" ] && MEMHOUSE_DB=$_d
if [ -z "${MEMHOUSE_URL:-}" ] || [ -z "${MEMHOUSE_USER:-}" ]; then
  echo "no memhouse house configured — nothing in $MH_ENV and no MEMHOUSE_URL/MEMHOUSE_USER set." >&2
  echo "Run: memhouse install" >&2
  exit 1
fi

curl -sS --fail-with-body --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-$MEMHOUSE_USER}&final=1&join_use_nulls=1&readonly=1" <<'SQL'
<the query>
FORMAT JSONEachRow
SQL
```

`readonly=1` is pinned on every request: this skill never writes.

## Answering from another person's house (shared with you)

The house is a ClickHouse database; a share is a read-only GRANT on it. When the user asks
about a FRIEND's memory — "how did yigit fix X", "in yigit's house", "ask yigit's memory",
"from yigit" — answer from THEIR house without changing your credentials:

1. **Resolve the house.** `SHOW DATABASES` returns what your credential may read; a name
   that is not `system` / `information_schema` / `default` and not your own `$MEMHOUSE_DB`
   is a house shared with you. Match the named person to one; set `HOUSE=yigit`. With no
   house named, `HOUSE=$MEMHOUSE_DB`.
2. **Point the connection at it:** replace `database=${MEMHOUSE_DB:-$MEMHOUSE_USER}` with
   `database=<HOUSE>` in the recipe above. The rooms (`messages`, `sessions`) resolve by
   the connection's database, so retrieval, the transcript read, and the citation all run
   against that house — leave the table names bare.
3. **Cite the house.** Say whose memory the answer came from ("from yigit's house") so the
   user never mistakes a friend's session for their own.
4. **Read-only, thin by design.** A refused SELECT means the house was not shared with you
   (or the share was revoked) — say so; never guess another database.

## The method — retrieve, read, answer, cite

**Escaping, before anything touches SQL.** Search terms, session ids and user ids are
arbitrary text going inside single-quoted literals: escape backslashes then single
quotes (`\` → `\\`, `'` → `\'`) in every value you splice in. A term like `O'Reilly`
otherwise breaks the query — and crafted text could reshape it.

**1. Extract search terms from the question.** Not the question verbatim — the terms
that would appear in the ANSWER. "How did I fix the ClickHouse auth error?" → search
`ClickHouse auth`, `Authentication failed`, `ACCESS_DENIED` — error strings beat
paraphrases, identifiers beat prose. Run 2–3 term variants; the FTS columns are
lowercased, so lowercase your needle.

```sql
SELECT session_id, any(folder) AS folder,
       formatDateTime(max(ts), '%Y-%m-%d') AS day, count() AS hits,
       substring(anyIf(text, positionCaseInsensitive(text, 'NEEDLE') > 0), 1, 300) AS sample
FROM messages
WHERE text_ngram LIKE '%needle%'
GROUP BY session_id ORDER BY max(ts) DESC LIMIT 8
```

**2. Read the strongest sessions — the actual turns, not just the hit line.** Pull a
window around the hits so you see the resolution, not the complaint:

```sql
SELECT seq, role, substring(text, 1, 2000) AS text
FROM messages
WHERE session_id = '<sid>' AND user_id = '<uid>'
  AND seq BETWEEN <hit_seq - 3> AND <hit_seq + 12>
ORDER BY seq
```

Join on `(session_id, user_id)` always — two housemates can collide on an
adapter-local session id.

**3. Answer, then cite.** Lead with the answer; under it list the sessions it came
from — `session_id`, date, project — so the user can reopen one (`memhouse resume
<session_id>` prints the command). Quote the decisive lines verbatim where the exact
wording matters (error text, a command, a config value).

**4. Nothing found is an answer too.** Say what you searched and where the house's
coverage ends (`SELECT min(ts), max(ts), count() FROM messages`) rather than padding.

## What can bite

- **Rows can hold more than one PARSE of a session** (`origin`/`epoch` are in the key —
  the house retains superseded parses instead of deleting them). Counts and rollups must
  filter to the current epoch:
  ```sql
  WHERE origin != 'ship'
     OR (session_id, user_id, epoch) IN (
          SELECT session_id, user_id, max(epoch) FROM messages
          WHERE origin = 'ship' GROUP BY session_id, user_id)
  ```
  For step 2's transcript reads, PREFER the filter as well — an unfiltered read of a
  compacted session interleaves two parses. Drop it deliberately only when the question
  is about what a session said BEFORE it was compacted; the superseded epochs are the
  one place that content still exists.
- **`text` is truncated at 50,000 chars** and tool args at 20,000 — a missing tail is
  truncation, not absence.
- The rollup (`sessions_v`) is a saved query, not a table — get it with
  `memhouse sessions-query` if you need per-session totals.
