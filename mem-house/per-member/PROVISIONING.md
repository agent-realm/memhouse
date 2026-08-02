# PROVISIONING — minting a member and their rooms

Skeleton. The grant set is the load-bearing part; the capability script is not written.

## The grant set

Three explicit grants per room. **No wildcards** — `GRANT … ON memhouse.alice_*` also
matches `alice_bob_messages`, which silently hands one member another's memory when a
handle prefixes another handle. Measured, not theoretical.

```sql
-- per member <m>, per room <r> in {sessions, messages, tool_calls}
GRANT SELECT, INSERT ON memhouse.<m>_<r> TO <m> WITH GRANT OPTION;
```

`WITH GRANT OPTION` is what makes sharing self-serve (see `SHARING.md`). Without it
every share is an operator ticket.

> **OPEN:** does the member also get `CREATE TABLE` / `DROP TABLE` on their rooms?
> The lab confirms a member so granted can create their own rooms and is denied
> outside their prefix — which would let `--ensure-schema` run as the member and make
> onboarding need no owner involvement at all. Against: a member can then drop their
> own memory, and a schema migration is no longer centrally enforceable.

The owner (`memhouse_root`) holds `ALL ON memhouse.* WITH GRANT OPTION`, so a second
member joining an existing house needs no new owner setup — the house, the owner, and
the Merge rooms are already there.

## Kernel path

The kernel provides capabilities that run multi-statement, branching SQL, so
provisioning is one capability rather than a runbook.

```
install-agency{memhouse}        -- once: house + memhouse_root + owner grants
register-member{handle}         -- ego mints the identity, mayor approves
provision-member-rooms{handle}  -- NEW: create 3 rooms + 3 grants, idempotent
```

`provision-member-rooms` should:

1. validate the handle (no `_`; see `SCHEMA.md`),
2. `CREATE TABLE IF NOT EXISTS` the three rooms from the DDL template,
3. issue the three grants,
4. be safe to re-run — it is also the migration hook when a room gains a column.

> **OPEN:** does this capability run as the ego or as `memhouse_root`? The owner has
> the rights; the ego has the approval flow. Probably owner, invoked by the ego.

## Standalone path

No kernel, so no capability layer. The CLI does the same three steps against whatever
credential it was given.

> **OPEN:** the standalone story is genuinely different, not just "the same without
> approvals". Today `memhouse install` assumes one credential that owns everything.
> Under this fork a standalone user is simultaneously owner and member, and it is
> unclear whether they should hold two credentials or one with both roles. Decide
> before writing the CLI path.

## Row-policy rights

`GRANT ACCESS MANAGEMENT ON memhouse.*` expands to
`CREATE/ALTER/DROP/SHOW ROW POLICY ON memhouse.*` — house-scoped, no global access
management needed. This is what lets the owner serve partial-share requests
(`SHARING.md`).

**Grant it to the owner only.** The scope is the house, not a room prefix, so any
holder could attach a policy to another member's rooms. Policies filter rather than
grant, so this is not a data leak — but it is a denial of service on a colleague's
own reads.

## Not yet written

- the capability script
- handle validation (shared with `SCHEMA.md`)
- what happens on member removal — `DROP TABLE` the three rooms, revoke, and what
  becomes of rooms they had shared outward
