# SCHEMA — rooms, keys, Merge rooms, the rollup
The room shapes, keys and Merge rooms are
unchanged. What changes is that v4's decision about `sessions_v` — *a saved query, not a
room* — is now the implemented one, after a detour through a stored view that this
version records rather than hides.

## `sessions_v` is a saved query, not a room

v4 said so. Round 1 of the review campaign implemented it as a **stored view** instead —
reactively, to fix a finding that the read layer named the shared rooms — without going
back to this file. Everything that followed was the cost of that override:

- the view needed a name, and `sessions_v_<m>` sits inside the `^sessions_` pattern the
  Merge rooms select on. `all_sessions` silently absorbed every member's aggregate view
  alongside their base room: **161 sessions counted as 322**.
- so the name moved to `v_sessions_<m>`, which then needed a reserved prefix so no member
  handle could re-create the collision;
- and a fourth grant per member, because a recipient given the three rooms could read rows
  and use none of the product's read paths;
- and a fourth object to create, roll forward, check in `doctor`, and eventually drop.

None of that buys anything the query does not already do. Reverted.

### What it is now

`rooms.js` exposes `sessions_v` as **SQL text** — a parenthesised `SELECT` over the
caller's own rooms. It drops into the same `FROM … AS c` position a view name would have
occupied, so the read layer treats it as just another resolved room name and the
substitution point is one function. (The shared layout, where this key resolved to a
stored view's *name*, is gone; the text form is the only one now.)

```sql
FROM {{sessions_v}} AS c        -- resolves to:  FROM ( SELECT … FROM sessions_alice … ) AS c
```

It runs **under the caller's credential**, substituted with the caller's own room names,
so it inherits their grants exactly and raises no view-ownership question at all.

### The two properties that had to survive

- the join is a **LEFT JOIN**, so a session with no messages still appears with zero
  aggregates instead of vanishing from every count;
- `join_use_nulls = 1` makes the unmatched message columns NULL, so `coalesce` yields true
  zeros rather than counting the placeholder row.

The view carried the second as a trailing `SETTINGS` clause. **A subquery cannot**, so it
moved to the caller: `READ_SETTINGS = { final: 1, join_use_nulls: 1 }`, applied by the
dashboard client, the shipper and the CLI's raw HTTP alike. A unit check asserts the text
carries no `SETTINGS` of its own, because putting it back would break every read that uses
the rollup.

### The cost, stated plainly

An agent writing ad-hoc SQL has no name to type. `memhouse sessions-query` prints the
rollup resolved for whoever the configured credential is, and the three delivery skills
point at it. That is a worse affordance than a name, and it is the price of the property
that made v4 choose a query: nothing to own, nothing to grant, nothing in a namespace.

## Room naming, keys, Merge rooms

Unchanged from v4. Rooms are type-first — `sessions_<m>`, `messages_<m>`,
`tool_calls_<m>` — so the Merge rooms anchor on a fixed room type and never match
themselves. With the view gone, `^sessions_` now matches **only** base session rooms,
which is what it was always supposed to mean.

> **OPEN** (carried from v4): is `all_sessions` a Merge over the member `sessions_*`
> rooms, or a saved query over `all_messages`? The first is cheaper; the second guarantees
> the aggregates match the per-member rollup exactly.

## Not yet written

- the kernel capability that provisions a member
- member removal: drop the three rooms, revoke, decide what happens to rooms shared outward

## What a member can still learn about the others

Isolation is a grant that is absent, so no member can read another's rows — verified by
trying every read and write against another member's rooms, plus `system.parts`,
`system.query_log`, `system.processes` and the rest, all of which refuse. Two things do
leak, both structural rather than bugs in the code, and neither is fixed by tightening a
grant:

**The roster.** A member's handle is part of their table name, and ClickHouse distinguishes
"forbidden" from "absent": `SELECT count() FROM messages_bob` returns `Code: 497
ACCESS_DENIED` (HTTP 500) if bob exists and `Code: 60 UNKNOWN_TABLE` (HTTP 404) if he does
not. So any member can enumerate the membership of the house by guessing handles.
`system.tables` correctly hides the other rooms; this reopens it. `EXISTS TABLE` does not
leak — it answers 497 either way — so it is specifically the natural probe that talks. If
the membership of a house is itself sensitive, the per-member layout is the wrong shape for
it.

**Volume.** `system.tables.total_rows` and `total_bytes` are readable for the Merge rooms,
and a Merge room spans every member:

    name            total_rows   total_bytes
    all_messages    87           42455        <- the whole house
    messages_alice  33           25070        <- what alice can actually read

So a member can see the house's combined row count and byte volume, and by polling it, when
other members are shipping. Withholding `SELECT` on the Merge rooms is not the fix — it
makes the team room deny rather than narrow, which is the property those rooms exist for.

## Why members are not granted ALL on their own rooms

`GRANT ALL ON <db>.messages_<m>` expands to 45 privileges on 26.7, and one of them is
`CREATE TABLE` **on that name**. A member would then own the name rather than the data:

    DROP TABLE messages_alice;
    CREATE TABLE messages_alice AS all_messages ENGINE = Merge('<db>','^messages_');

`all_messages` is `Merge(db,'^messages_')`, so it now contains a Merge over its own
namespace and every other member's rows are counted twice in the team room — measured, a
house reading alice 6030 / bob 2401 / carol 12 became bob 4802 / carol 24, with no error.
Confidentiality survives (the Merge still narrows by grants) but integrity does not, and a
team-wide number is what the room is for. It is the same failure recorded above under the
`sessions_v` rename, reached on purpose instead of by accident.

Members therefore get exactly what the shipper uses — `SELECT, INSERT, ALTER UPDATE, ALTER
DELETE, ALTER ADD COLUMN, OPTIMIZE` — and nothing that defines an object. Replacing a room
is the admin's job.
