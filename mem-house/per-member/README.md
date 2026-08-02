# per-member rooms — skeleton

A fork of the mem-house data model: **one house, a set of rooms per member**, instead of
one house with three rooms shared by everyone and separated by a row policy.

Nothing here is built. These are design skeletons with the decisions taken so far and the
open questions marked. The working design is still `../DESIGN.md` and `../schema.sql`.

## Current version — v2 (2026-08-02-22_42)

| File | What |
|---|---|
| [`PLAN-v2-2026-08-02-22_42.md`](PLAN-v2-2026-08-02-22_42.md) | why, what changes, phases, the measured facts it rests on |
| [`SCHEMA-v2-2026-08-02-22_42.md`](SCHEMA-v2-2026-08-02-22_42.md) | room naming, shapes, sort keys, Merge rooms, `sessions_v` as a saved query |
| [`PROVISIONING-v2-2026-08-02-22_42.md`](PROVISIONING-v2-2026-08-02-22_42.md) | the grant set, kernel capability, standalone path |
| [`SHARING-v2-2026-08-02-22_42.md`](SHARING-v2-2026-08-02-22_42.md) | whole-room self-serve, partial rows via the owner |
| [`MIGRATION-v2-2026-08-02-22_42.md`](MIGRATION-v2-2026-08-02-22_42.md) | **deferred** — keeps the two findings v1 uncovered |

Superseded, kept as written: [`PLAN.md`](PLAN.md), [`SCHEMA.md`](SCHEMA.md),
[`PROVISIONING.md`](PROVISIONING.md), [`SHARING.md`](SHARING.md),
[`MIGRATION.md`](MIGRATION.md).

## The one-paragraph version

The house is **`mem`**. Each member gets `mem.sessions_<member>`, `mem.messages_<member>`,
`mem.tool_calls_<member>` and three explicit grants over them `WITH GRANT OPTION`.
Isolation stops being a row policy that must be right everywhere and becomes a grant that
is simply absent — it fails closed. Sharing a whole room needs no operator. Team-wide
reads come from `Merge` rooms (`^messages_`), which reduce to each caller's own grants,
auto-discover new members, and tolerate schema drift.
`user_id MATERIALIZED currentUser()` stays on every room, and since ClickHouse has no
impersonation, that stamp is proof rather than convention.

## What changed in v2

- House renamed `memhouse` → **`mem`**.
- Room naming flipped to **type-first** (`messages_alice`), which kills v1's Merge
  self-match: `^messages_` can never match `all_messages`.
- **Migration deferred** to a separate task.
- Recorded that **ClickHouse has no impersonation** — `SET SESSION AUTHORIZATION` does
  not exist and `SET ROLE` does not change `currentUser()`.

## Read the plan first

It lists the behaviours measured on ClickHouse 26.7.1 that the design rests on —
including the wildcard-grant collision that rules out `GRANT … ON mem.alice_*`, and why
schema rollout is progressive. Re-run them before building; do not take them on trust.

## Biggest open questions

1. **May members create and drop their own rooms?** It works and is safely scoped, but it
   lets a member drop their own memory and makes schema rollout non-central.
2. **Key order** — is `user_id` still worth a slot in `ORDER BY` now that the room is the
   tenant?
3. **Standalone path** — a user with no kernel is both owner and member; one credential
   or two?
