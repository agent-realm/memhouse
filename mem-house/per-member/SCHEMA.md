# SCHEMA — rooms per member

Skeleton. Shapes and decisions; the DDL template is not written yet.

## Naming

```
memhouse.<member>_sessions
memhouse.<member>_messages
memhouse.<member>_tool_calls
memhouse.all_<room>          -- Merge rooms, owner-managed
```

`<member>` is the ClickHouse username, unmodified. **Handles must not contain `_`** —
not because grants are wildcarded (they are not), but because every future tool that
wants to pattern-match rooms will otherwise be one regex away from crossing members.

> **OPEN:** prefix (`alice_messages`) vs suffix (`messages_alice`). Prefix keeps a
> member's rooms adjacent in `SHOW TABLES`; suffix groups by room type and makes the
> Merge regex trivially anchored (`^messages_`). Decide before anything writes DDL.

## Room shapes

Unchanged from `../schema.sql` except where noted. Each room keeps:

- its typed columns,
- `extra JSON` — the escape hatch, never lose an adapter field to the schema,
- `user_id String MATERIALIZED currentUser()` — **retained deliberately**, see below,
- `ingested_at`, and `ReplacingMergeTree(ingested_at)` for idempotent re-ship.

`<member>_messages` also keeps both full-text layers: `text_ngram`
(`ngrams(3)`, substring/`LIKE`) and `text_word` (`splitByNonAlpha`, whole-word), each
carrying one text index.

### Why `user_id` survives a room-per-member

The room already identifies the member, so the column looks redundant. It is not:

- a room shared with a colleague still says who wrote each row;
- the Merge rooms stay meaningful — `_table` says which room, `user_id` says which
  member wrote it, and the two can disagree once rooms are shared;
- it remains server-stamped and unspoofable, so it is the only trustworthy provenance
  in a house where clients supply everything else.

Cost is one `LowCardinality`-shaped string per row. Keep it.

## Sort keys

Today: `(session_id, user_id, seq)`. With one room per member the `user_id` slot buys
nothing for filtering, since the room *is* the tenant.

> **OPEN:** drop to `(session_id, seq)`, or keep `user_id` for the shared-room case?
> Note the shared case is exactly when a room contains more than one `user_id`, which
> only happens if a member writes into a room they were granted — currently not a
> supported flow.

## Team-wide reads: the Merge rooms

```sql
CREATE TABLE memhouse.all_messages AS memhouse.<any-member>_messages
ENGINE = Merge('memhouse', '^.*_messages$');
```

Measured behaviour worth relying on:

- **Fails closed.** A caller granted the Merge room plus only their own underlying
  room sees only their own rows. No leak, no error. So the Merge rooms can be granted
  broadly rather than reserved for an analytics role.
- **Auto-discovers.** New member rooms appear without redefining the Merge room.
- **Tolerates drift.** A room missing a column yields that column's default rather
  than failing the query — which is what makes migration progressive.
- **Rejects mutations.** `ALTER … MATERIALIZE COLUMN` on a Merge room errors with
  `Table engine Merge doesn't support mutations`. Merge rooms are read paths only.

The regex must not match the Merge rooms themselves. With the `all_` prefix and a
`^.*_messages$` pattern, `all_messages` **does** match itself — anchor it properly or
name the Merge rooms outside the pattern.

> **OPEN:** that self-match is a real bug waiting to happen. Either name Merge rooms
> `memhouse.__all_messages`, or exclude them by pattern, or put them in a second house.

## `sessions_v` is no longer a room

It becomes a **saved query**, substituted with the caller's room names and run under
the caller's own credential — so it inherits their grants with no view ownership
question. The aggregate shape (started/ended, per-role counts, model array, token
sums, `first_prompt`) is unchanged; see `../schema.sql` for the current expression.

Two properties of the current view that must survive the port: the join is a **LEFT
JOIN**, so a session with no messages still appears with zero aggregates instead of
vanishing, and `join_use_nulls = 1` makes unmatched columns NULL so the `coalesce`
calls produce true zeros.

## Not yet written

- the room DDL template (one file, `{{MEMBER}}` substituted)
- the Merge room DDL and its naming resolution
- whether `all_sessions` is a Merge over member `sessions` rooms or a saved query over
  `all_messages`
