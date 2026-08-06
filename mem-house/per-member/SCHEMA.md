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

`rooms.js` exposes `sessions_v` as **SQL text**: the stored view's name in the shared
layout, and a parenthesised `SELECT` over the caller's own rooms in the per-member layout.
Both drop into the same `FROM … AS c` position, so the read layer is identical either way
and the substitution point is one function.

```sql
FROM {{sessions_v}} AS c        -- shared:      FROM sessions_v AS c
                                -- per-member:  FROM ( SELECT … FROM sessions_alice … ) AS c
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
