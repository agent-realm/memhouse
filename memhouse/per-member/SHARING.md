# SHARING — two tiers

**A share is three grants**, one per room, and there is no fourth: the rollup is a saved
query over exactly those rooms rather than a stored object, so a recipient who can read
the rooms can run it.

A share is also **read-only by construction**. `WITH GRANT OPTION` is attached to the
member's `SELECT` grant and not to their `ALL` grant ([PROVISIONING](PROVISIONING.md)),
so alice cannot hand bob mutation or drop rights on her room even by mistake.

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

The stamp is also pinned **server-side**: the member settings profile carries
`async_insert = 0 CONST`. A MATERIALIZED column is computed during the insert, and an
async insert flushes outside that context — measured on 25.11.9.34, `async_insert=1`
stores `user_id` as the empty string while a sync insert on the same table stamps
correctly. The shipper always passed `async_insert=0`, so memhouse was never the risk;
anything else holding a member credential was. With the constraint in force a client that
*asks* for `async_insert=1` is refused (`SETTING_CONSTRAINT_VIOLATION`), and one that
simply does not mention the setting is held at 0 — so the insert still succeeds, stamped,
rather than landing unowned. It is the override that is refused, not the write.

Two limits worth stating plainly. The constraint binds the **ClickHouse user**, not the
database — if you reuse a member's credential for unrelated high-throughput ingestion
elsewhere on that server, async inserts are refused there too. And it only takes effect
once the profile is applied: a house provisioned by an older memhouse keeps the old
profile until any member is provisioned again, which now updates the shared profile for
everyone at once. `doctor`'s blank-`user_id` check remains as the detector for rows
written before that.

## What the boundary does NOT hide: the roster

**Members can discover which other members exist, and this is not fixable here.** A
handle is a table name, and ClickHouse answers differently for a table you may not read
than for one that is not there:

```
SELECT count() FROM mem.messages_alice    -- exists, not granted → Code 497, Not enough privileges
SELECT count() FROM mem.messages_nobody   -- does not exist      → Code 60,  Unknown table
```

So probing names enumerates the membership. Measured on 26.7.3.19 that this is
**ClickHouse's behaviour and not a consequence of our grant set**: a user holding *zero*
grants anywhere in the database gets exactly the same 497/60 split. No grant, revoke or
role arrangement changes it.

It *is* closable, and the price is the reason it stays open. Suffixing rooms with a random
token (`messages_alice_8f9b2a`) would still match the `^messages_` Merge selectors, and
would still leave the share in this document working — alice grants on the room she owns
and knows, and bob never needs its name. What it costs is that a room name stops being
**derivable**: `roomNames(member)` is pure today, and every client — the shipper, the
skills, `sessions-query`, a person typing SQL — would instead have to look its own name up
first. A real trade, deliberately not taken; not an impossibility.

What leaks is **membership, not content**: names and the fact of existence, never rows,
counts or sizes. In the setting this is built for — a team who already know they are a
team — that is not a secret. Say so out loud rather than implying the boundary is
tighter than it is.

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
