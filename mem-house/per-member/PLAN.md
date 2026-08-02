# per-member rooms — plan

Fork of the mem-house data model: **one house, a set of rooms per member**, replacing
**one house, three rooms shared by everyone**.

Canon (`../../TERMINOLOGY.md`): a *house* is a database, a *room* is a table, a
*member* is a registered user with grants. Today `memhouse` has three rooms —
`sessions`, `messages`, `tool_calls` — and every member's rows live in all three,
separated by a row policy. This fork gives each member their own rooms in the same
house: `memhouse.<member>_sessions`, `_messages`, `_tool_calls`.

Status: **skeleton**. Nothing here is built. Numbers and behaviours cited below were
measured on ClickHouse 26.7.1 in a disposable lab, not assumed.

## Why

**Isolation becomes structural instead of policy-shaped.** A row policy is a filter
that must be correct on every room for every role; one wrong predicate exposes
everything. A missing grant exposes nothing. Structural isolation fails closed.

**Personal reads stop paying for everyone else.** The shared rooms are ordered
`(session_id, user_id, seq)` — `session_id` leads, so filtering by member cannot
prefix-scan and touches every granule. At one member that is invisible; at a hundred
every personal query and every full-text lookup scans roughly 100× what it needs, and
the personal query is the common case.

**Sharing becomes self-serve.** A member holding grant-option on their own rooms can
`GRANT SELECT` to a colleague without an operator. Under row policies the same act
requires `CREATE ROW POLICY`, which the kernel withholds from agency owners.

**Per-member lifecycle is atomic.** Delete, export, retention, and quota are
`DROP TABLE` / per-room settings rather than mutations over a shared
`ReplacingMergeTree`.

## What stays

- **`user_id String MATERIALIZED currentUser()` on every room.** Even with a room per
  member. It is what makes a shared or merged read still say who wrote each row, and
  it costs nothing. (memory-house's prefixed model drops it and cannot do the team
  view cleanly — do not copy that.)
- The typed common schema, `extra JSON` escape hatch, `ReplacingMergeTree(ingested_at)`,
  `final=1` reads, and the two full-text index columns on messages.
- Parse-on-client. The shipper still runs the 17 adapters and writes typed rows.
- The REST contract and the borrowed dashboard.

## What changes

| | today | this fork |
|---|---|---|
| rooms | 3, shared | 3 per member |
| isolation | row policy `TO member` | grants on `<member>_*` rooms |
| `sessions_v` | a stored view | a **saved query**, run as the caller |
| team-wide read | inherent | a `Merge` room over `^.*_messages$` |
| onboarding | `GRANT` on the house | kernel capability mints user + rooms + grants |
| migration | one `ALTER` | one `ALTER` per member room, progressive |

## Measured facts this plan depends on

Each was verified in the lab; the tests are worth re-running before building.

1. **Prefix-wildcard grants exist and enforce**, but **collide**:
   `GRANT SELECT ON memhouse.alice_*` also matches `alice_bob_messages`, so a member
   whose handle prefixes another's reads their memory. **Use explicit per-room grants
   (three per member), not wildcards.** Suffix wildcards (`*_alice`) are a syntax
   error, so the `<table>_<member>` naming variant cannot use wildcards at all.
2. **Members can self-provision.** With `CREATE TABLE, SELECT, INSERT, DROP TABLE` on
   their own rooms, a member created their rooms, inserted, and read back a correctly
   stamped `user_id`; creating a room outside their prefix was denied.
3. **`Merge` fails closed on permissions.** A member granted the Merge room plus only
   one underlying room saw only that room's rows — no leak, no error. One team room
   can be granted broadly and reduces to each caller's actual grants.
4. **`Merge` auto-discovers new rooms.** It is a regex over names; a room created
   after the Merge room existed was picked up with no redefinition.
5. **Migrations are progressive, not lock-step.** `Merge` returns the column default
   for rooms that lack it. Add a column to the Merge room first, then migrate member
   rooms at any pace — reads never break. (`MATERIALIZE COLUMN` does **not** help
   here, and `Merge` rejects mutations outright.)
6. **Row-policy rights are database-scopeable.** `GRANT ACCESS MANAGEMENT ON memhouse.*`
   expands to `CREATE/ALTER/DROP/SHOW ROW POLICY ON memhouse.*` — so the kernel can
   let the owner manage policies inside its own house without global access
   management. Grant this to the owner only: the grant is house-scoped, not
   room-scoped, so any holder could attach policies to another member's rooms.

## Phases

1. **Schema + naming.** Room naming, key order, the Merge room, handle validation.
2. **Provisioning.** Kernel capability (multi-statement, branching) and the
   standalone path; the exact grant set.
3. **Query layer.** Replace the stored `sessions_v` with a saved query; give the
   shipper, server, and skills a way to resolve the caller's room names.
4. **Sharing.** Room-level self-serve grants; row-level partial sharing via the owner.
5. **Migration.** Move an existing shared-room house to per-member rooms.

## Open questions

- **Naming:** `<member>_messages` or `messages_<member>`? Prefix reads better and
  keeps a member's rooms adjacent in `SHOW TABLES`; suffix groups by room type and
  makes the Merge regex trivially safe (`^messages_`). Wildcard grants are ruled out
  either way, so this is ergonomics, not security.
- **Handle validation.** Even with explicit grants, forbid `_` in handles? It costs
  nothing and removes an entire class of future wildcard mistakes.
- **Key order.** With one room per member, is `user_id` still worth a slot in
  `ORDER BY`, or does `(session_id, seq)` suffice now that the room is the tenant?
- **Who owns the Merge room** and its migrations — the owner, presumably, in the same
  capability that migrates member rooms.
- **Does `--ensure-schema` run as the member?** The lab says it can. That would make
  onboarding need no owner involvement beyond minting the user.
- **Standalone story.** Without a kernel there is no capability layer; does the CLI
  provision rooms itself, and under what credential?

## Out of scope

- **`agent_id` / crew identity.** Deliberately deferred. Note for later: within a crew
  sharing one credential, an agent identifier is client-supplied and therefore **not**
  a security boundary — enforced separation between agents needs separate users.
- Changing the adapters, the REST contract, or the dashboard.
