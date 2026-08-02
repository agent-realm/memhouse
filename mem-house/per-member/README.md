# per-member rooms — skeleton

A fork of the mem-house data model: **one house, a set of rooms per member**, instead
of one house with three rooms shared by everyone.

Nothing here is built. These are design skeletons with the decisions taken so far and
the open questions marked. The working design is still `../DESIGN.md` and
`../schema.sql`.

| File | What |
|---|---|
| [`PLAN.md`](PLAN.md) | why, what changes, phases, measured facts the plan rests on |
| [`SCHEMA.md`](SCHEMA.md) | room naming, shapes, sort keys, the `Merge` rooms, `sessions_v` as a saved query |
| [`PROVISIONING.md`](PROVISIONING.md) | the grant set, kernel capability, standalone path |
| [`SHARING.md`](SHARING.md) | whole-room self-serve, partial rows via the owner |
| [`MIGRATION.md`](MIGRATION.md) | shared rooms → per-member rooms; schema change once split |

## The one-paragraph version

Each member gets `memhouse.<member>_sessions`, `_messages`, `_tool_calls` and three
explicit grants over them `WITH GRANT OPTION`. Isolation stops being a row policy that
must be right everywhere and becomes a grant that is simply absent — it fails closed.
Sharing a whole room needs no operator. Team-wide reads come from `Merge` rooms, which
measurably reduce to each caller's own grants, auto-discover new members, and tolerate
schema drift. `user_id MATERIALIZED currentUser()` stays on every room so provenance
survives a share.

## Read `PLAN.md` first

It lists six behaviours measured on ClickHouse 26.7.1 that the whole design rests on —
including the wildcard-grant collision that rules out `GRANT … ON memhouse.<member>_*`,
and the reason migrations are progressive rather than lock-step. Re-run them before
building; do not take them on trust.

## Biggest open questions

1. **`user_id` on migration.** It is `MATERIALIZED currentUser()`, so a fan-out run by
   the owner rewrites every row's provenance. Blocks `MIGRATION.md` section A.
2. **Merge room self-match.** `^.*_messages$` matches `all_messages`. Name or anchor
   around it.
3. **Prefix or suffix naming**, and whether members may create and drop their own rooms.
