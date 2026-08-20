---
name: status
description: Show the state of the memory system — what the house holds (sessions, messages, tokens per editor), how fresh it is, its schema generation and migration state, and every machine writing into it. Use when the user asks "is my memory working", "how much is stored", "when did it last ship", "what's in the house", "which machines are shipping", or before debugging why a search found nothing.
user-invocable: true
argument-hint: ""
allowed-tools: Bash
---

# /mem:status — the state of the memory system

**Invoking this skill IS the request. Run the report immediately — connect, run the four
sections below, and present the summary. There are no arguments and nothing to clarify;
do not describe this skill or ask what to check.** (Driven live, a model did exactly
that: it summarized the file and asked "is there something specific?" — a status command
that answers with a question has failed.)

One report, four sections: what the house holds, how fresh it is, what generation it is
at, and who writes into it. Read-only; nothing here changes anything.

## Connection

**Never print this file or the variables in it.** No `cat "$MH_ENV"`, no `env | grep
MEMHOUSE`, no `set -x` around these commands. Anything you print becomes part of a
transcript that memhouse itself ships into the house.

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
  --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-mem}&final=1&join_use_nulls=1&readonly=1" <<'SQL'
<the query>
FORMAT PrettyCompact
SQL
```

## The report — run these, then summarize

**1. What the house holds** — per editor, CURRENT parses only (the rooms retain
superseded parses; an unfiltered count over-reports on any compacted session):

```sql
SELECT source,
       uniqExact(session_id) AS sessions,
       count() AS messages,
       sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
FROM messages
WHERE origin != 'ship'
   OR (session_id, user_id, epoch) IN (
        SELECT session_id, user_id, max(epoch) FROM messages
        WHERE origin = 'ship' GROUP BY session_id, user_id)
GROUP BY source ORDER BY sessions DESC
```

**2. Freshness and coverage** — when the archive starts, ends, and last received:

```sql
SELECT formatDateTime(min(ts), '%Y-%m-%d') AS oldest,
       formatDateTime(max(ts), '%Y-%m-%d %H:%i') AS newest,
       formatDateTime(max(ingested_at), '%Y-%m-%d %H:%i') AS last_ingest
FROM messages
```

A `last_ingest` hours old with the user actively working means the shipper is not
running — say so and point at `memhouse status` / `memhouse start` on that machine.

**3. Generation and migration state** — the house's record of itself (absent on a
pre-0.10 house; that absence is itself the answer: say the house predates the record):

```sql
SELECT key, value FROM house_meta FINAL
WHERE key IN ('schema_version', 'min_writer_schema') ORDER BY key
```
```sql
SELECT id, argMax(status, event_at) AS status,
       formatDateTime(max(event_at), '%Y-%m-%d %H:%i') AS at
FROM house_events WHERE kind = 'migration' GROUP BY id ORDER BY at DESC LIMIT 3
```

A `pending` here with nothing running means an interrupted migration — name
`memhouse migrate` (it refuses stale leftovers legibly rather than clobbering them).

**4. The fleet** — every machine writing into this house, from the DATA (a pre-0.10
writer records nothing about itself, so rows-without-record is the finding):

```sql
SELECT user_id, host, count() AS rows,
       formatDateTime(max(ingested_at), '%Y-%m-%d %H:%i') AS last_write
FROM messages GROUP BY user_id, host ORDER BY last_write DESC
```
```sql
SELECT key, value FROM house_meta FINAL
WHERE key LIKE 'client_version:%' OR key LIKE 'client_schema:%' OR key LIKE 'last_ship:%'
```

Match `client_*:<member>@<host>` against the data rows. A `(user_id, host)` pair with
rows but NO `client_*` record is a **pre-0.10 memhouse still writing** — flag it: its
re-ships delete retained parses, and the fixes are upgrade it or (as admin)
`REVOKE ALTER DELETE, ALTER UPDATE ON <db>.* FROM <member>`.

## Presenting it

Lead with one line of verdict ("healthy: N sessions across M editors, last ingest X
minutes ago" — or the one thing wrong). Then the per-editor table, then anything from
sections 3–4 that needs action. Skip empty sections; do not pad. If the house is
unreachable, say which URL refused and stop — never guess another endpoint.
