# SHARING — two tiers
v4 said a share is four grants, because each
member then had a stored `sessions_v`. That view is gone — the rollup is a saved query
again (SCHEMA v5) — so **a share is three grants**, and the fourth one v4 warned you not
to forget no longer exists to forget.

## Tier 1 — whole room, self-serve

A member holds `WITH GRANT OPTION` on their own three rooms — there is no fourth object
to hold anything on — so they share without an operator:

```sql
GRANT SELECT ON mem.messages_alice   TO bob;
GRANT SELECT ON mem.sessions_alice   TO bob;
GRANT SELECT ON mem.tool_calls_alice TO bob;
```

**Three statements.** The rollup every read path uses is a saved query over exactly these
rooms, run under the recipient's own credential — so a recipient who can read the rooms
can run it, and there is no fourth grant to forget. That is the concrete payoff of the
query over the view, and it is why SCHEMA v4 chose it before the implementation briefly
went the other way.

`memhouse sessions-query` prints the rollup for whoever is connected, which is what a
recipient pastes into a `FROM (...) AS c` when writing ad-hoc SQL.

This is the tier per-member rooms exist to enable. Under a row policy the same act needs
`CREATE ROW POLICY`, which members do not have and the kernel withholds from agency
owners by default.

Bob reading `messages_alice` sees `user_id = 'alice'` on every row. That stamp is
unforgeable **by members**, since `EXECUTE AS` is a grantable privilege they do not hold,
and forgeable by the owner or anyone granted it. Trust boundary is the owner, not the
engine.

Bob's Merge-room reads widen automatically once alice grants him a room — `Merge` reduces
to the caller's actual grants, so nothing else needs changing. Measured end to end on
25.11: alice's `GRANT` took what bob sees of her rows through `all_messages` from 0 to
22,413, and her
`REVOKE` returned it to 0, and his direct read was denied again.

**A member must hold SELECT on the Merge rooms themselves** for any of that to work —
provisioning issues it. Without that grant the team room does not narrow to what the
caller can read, it denies outright, which looks identical to isolation and is not.

### Grant-option covers the whole grant

Alice's grant-option is over `SELECT, INSERT, ALTER UPDATE, ALTER DELETE`, so she *can*
hand bob the mutation rights on her own rooms, not merely `SELECT`. Her data, her call —
but a share is `SELECT`-only by convention, and nothing in the engine enforces the
convention. A `share` verb should encode it.

> **OPEN:** a `share` / `unshare` CLI verb wrapping the three grants, so a member never
> types SQL. Mirrors memory-house's `mh-share`.

## Tier 2 — some rows, owner-mediated

Row policies remain the only way to share a *subset*. The member asks the owner, who
holds house-scoped policy rights:

```sql
GRANT SELECT ON mem.messages_alice TO bob;                -- privilege
CREATE ROW POLICY share_alice_to_bob ON mem.messages_alice
  FOR SELECT USING <predicate> TO bob;                    -- restriction
```

Both halves are required: a policy filters, it never grants. Privilege without a policy
shares everything; a policy without privilege shares nothing.

> **OPEN:** which predicates — by project, by date range, by `source`? Free-form SQL from
> a member is an injection surface, so this likely wants a small fixed vocabulary.

> **OPEN:** what a partial recipient's rollup should show. The rollup is a saved query
> over `sessions_alice` and `messages_alice`, so a policy on `messages_alice` filters the
> rows it aggregates and the recipient sees totals computed over their own slice — which
> is arguably right, and is untested. Nothing extra has to be shared for it to work,
> which is one fewer moving part than the stored view had.

## Why the tiers are asymmetric

Deliberate. Whole-room sharing is the common case, is coarse, and is safe to self-serve —
the worst outcome is oversharing your own data. Partial sharing writes a filter into the
house's access model, so it goes through the owner.

## What sharing does not do

**It is not a boundary between agents sharing one credential.** A crew running under a
single member credential reads and writes the same rooms; any per-agent tag is
client-supplied. Enforced separation needs separate ClickHouse users, which means
separate rooms — this design one level down. Deferred with `agent_id`.

## Not yet written

- `memhouse share <member>` / `unshare`
- how the dashboard and skills list rooms a caller can read but does not own — filter
  `system.tables` by grants (it *is* grant-filtered: alice sees exactly her own three
  three rooms, measured), or read the Merge rooms and group by `_table`
- revocation when a member is removed while their rooms are shared outward
