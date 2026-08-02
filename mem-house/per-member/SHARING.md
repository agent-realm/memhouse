# SHARING — two tiers

Skeleton. The tiers are decided; the tooling is not.

## Tier 1 — whole room, self-serve

A member holds `WITH GRANT OPTION` on their own rooms, so they share without an
operator:

```sql
GRANT SELECT ON memhouse.alice_messages   TO bob;
GRANT SELECT ON memhouse.alice_sessions   TO bob;
GRANT SELECT ON memhouse.alice_tool_calls TO bob;
```

Three statements, one per room. This is the tier that per-member rooms exist to
enable — under a row policy the same act needs `CREATE ROW POLICY`, which members do
not have.

Bob reading `alice_messages` sees `user_id = 'alice'` on every row, because `user_id`
survives as a materialized column. Provenance holds across a share.

> **OPEN:** a `share` / `unshare` CLI verb wrapping the three grants, so a member
> never types SQL. Mirrors memory-house's `mh-share`.

## Tier 2 — some rows, owner-mediated

Row policies remain the only way to share a *subset*. The member asks the owner, who
holds house-scoped policy rights:

```sql
GRANT SELECT ON memhouse.alice_messages TO bob;           -- privilege
CREATE ROW POLICY share_alice_to_bob ON memhouse.alice_messages
  FOR SELECT USING <predicate> TO bob;                    -- restriction
```

Both halves are required: a policy filters, it never grants. Privilege without policy
shares everything; policy without privilege shares nothing.

> **OPEN:** what predicates are worth supporting? By project, by date range, by
> `source`? An arbitrary predicate is an injection surface if a member supplies it —
> so this probably needs a small vocabulary rather than free SQL.

## Why the tiers are asymmetric

Deliberate. Whole-room sharing is the common case, is coarse, and is safe to
self-serve — the worst outcome is oversharing your own data. Partial sharing writes a
filter into the house's access model, so it goes through the owner.

## What sharing does not do

**It is not a boundary between agents sharing one credential.** A crew running under
`memhouse_incident_231` all read and write the same rooms; nothing here separates
them. Any per-agent tag is client-supplied and therefore not enforceable. Enforced
separation means separate ClickHouse users, which means separate rooms — this design,
one level down. Deferred with `agent_id`; see `PLAN.md`.

## Not yet written

- `memhouse share <member>` / `unshare`
- how the dashboard and skills discover rooms a caller can read but does not own
  (`system.tables` filtered by grants? a saved query over the Merge rooms?)
- revocation semantics when a member is removed while their rooms are shared outward
