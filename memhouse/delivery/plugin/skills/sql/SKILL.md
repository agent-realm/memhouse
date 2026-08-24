---
name: sql
description: Run read-only SQL over memhouse conversation memory for numbers rather than transcripts — token spend, cost by model or editor or project, tool-call rankings, activity over time, busiest days, cache-hit ratios, session length distributions, or any custom aggregate across the typed sessions/messages/tool_calls tables. Use when the user wants a figure, a ranking, a trend or a breakdown - "what did I spend on Opus", "which tools do I use most", "how many sessions per project", "my busiest week", "compare editors". For finding or answering FROM past conversations, use /mem:recall instead. Works over your own house, or a housemate's when they name it.
user-invocable: true
argument-hint: "<the question, or the SQL>"
allowed-tools: Bash
---

# /mem:sql — analytics over the rooms

For **numbers**. When the answer is a passage from a past conversation, that is
`/mem:recall` — this skill counts, groups and ranks.

**Read `../reference/HOUSE.md` first.** Schema, connection, and the three traps. The epoch
filter in particular is not optional here: this is the skill most likely to produce a
figure someone acts on, and omitting it over-counted a real house by **34%**.

## Read-only, and that is enforced

Every query goes through `readonly=1`. The shipper is the only writer; a skill that
mutates the archive is a skill that can destroy it. Never `INSERT`, `ALTER`, `DROP`,
`TRUNCATE` or `OPTIMIZE` from here — not even "just to tidy up". If the user genuinely
wants a write, that is `/mem:admin` with its confirmations, not this.

## Method

1. **Say what you are counting** before running it — "messages, current parse only, by
   model, this year". Half of wrong analytics is a right query answering a different
   question.
2. **Apply the epoch filter to anything aggregating.** Copy it from the reference.
3. **Group by `(session_id, user_id)`** wherever a session is the unit.
4. **Show the SQL** beside the result. The user can re-run and adjust it; an unexplained
   number is not an answer.
5. **`FORMAT PrettyCompact`** for humans, `JSONEachRow` when you need to post-process.

## Shapes worth knowing

Cost is **derived**, not stored — `pricing.json` × tokens, per model.

```sql
-- spend by model, current parse only
SELECT model,
       count() AS messages,
       sum(input_tokens)  AS in_tok,
       sum(output_tokens) AS out_tok,
       sum(cache_read_tokens)  AS cache_read,
       sum(cache_write_tokens) AS cache_write
FROM messages
WHERE model != ''
  AND (origin != 'ship'
       OR (session_id, user_id, epoch) IN (
            SELECT session_id, user_id, max(epoch) FROM messages
            WHERE origin = 'ship' GROUP BY session_id, user_id))
GROUP BY model ORDER BY out_tok DESC
```

```sql
-- which tools, how often
SELECT tool_name, count() AS calls, uniqExact(session_id) AS sessions
FROM tool_calls
WHERE origin != 'ship'
   OR (session_id, user_id, epoch) IN (
        SELECT session_id, user_id, max(epoch) FROM messages
        WHERE origin = 'ship' GROUP BY session_id, user_id)
GROUP BY tool_name ORDER BY calls DESC LIMIT 25
```

Note `tool_calls` takes its epoch from **`messages`** — both rooms are written by the same
pass at the same epoch, and a parse that produced messages but no tool calls would
otherwise resolve to a superseded epoch and serve the wrong parse's calls.

```sql
-- activity by day, one machine
SELECT toDate(ts) AS day, uniqExact(session_id) AS sessions, count() AS messages
FROM messages
WHERE host = '<host>'
  AND (origin != 'ship'
       OR (session_id, user_id, epoch) IN (
            SELECT session_id, user_id, max(epoch) FROM messages
            WHERE origin = 'ship' GROUP BY session_id, user_id))
GROUP BY day ORDER BY day DESC LIMIT 30
```

For per-session totals, `memhouse sessions-query` prints a self-contained rollup that
already carries `FINAL` — prefer it to hand-joining `sessions` and `messages`.

## Caveat the answer, every time it needs it

These are properties of the data, not of your query, and a number presented without them
misleads:

- **Several adapters ship no tokens at all** — `kiro`, `vscode`, `zed`, and `cursor` on
  one storage path. Their cost reads `$0`, which means *unknown*. Exclude them or label
  them; never let them dilute an average silently.
- **Per-message timestamps are interpolated** for most adapters — only session bounds are
  real. Any hour-of-day or "peak time" result inherits that and should say so.
- **`text` truncates at 50,000 chars**, `args` at 20,000, so length statistics have a
  ceiling.
- **Tool results are not stored**, so nothing here can measure what a command returned.

## Someone else's house

`SHOW DATABASES` lists what your credential may read; anything that is not `system`,
`information_schema`, `default` or your own is a share. Point `database=` at it, leave
table names bare, and say whose house the number came from.
