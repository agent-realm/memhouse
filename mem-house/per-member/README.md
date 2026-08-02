# per-member rooms — skeleton

A fork of the mem-house data model: **one house, a set of rooms per member**, instead of
one house with three rooms shared by everyone and separated by a row policy.

Nothing here is built. These are design skeletons with the decisions taken so far and the
open questions marked. The working design is still `../DESIGN.md` and `../schema.sql`.

This README is the living index; the design docs are versioned and never rewritten.

## Current — v3 (2026-08-02-22_49)

| File | What |
|---|---|
| [`PLAN-v3-2026-08-02-22_49.md`](PLAN-v3-2026-08-02-22_49.md) | why, what changes, phases, the measured facts it rests on |
| [`SCHEMA-v3-2026-08-02-22_49.md`](SCHEMA-v3-2026-08-02-22_49.md) | room naming, shapes, sort keys, Merge rooms, `sessions_v` as a saved query |
| [`SHARING-v3-2026-08-02-22_49.md`](SHARING-v3-2026-08-02-22_49.md) | whole-room self-serve, partial rows via the owner |
| [`MIGRATION-v3-2026-08-02-22_49.md`](MIGRATION-v3-2026-08-02-22_49.md) | **deferred**, and no longer blocked |
| [`PROVISIONING-v2-2026-08-02-22_42.md`](PROVISIONING-v2-2026-08-02-22_42.md) | the grant set, kernel capability, standalone path — **still current**, v3 did not touch it |

Superseded, kept as written: [`PLAN-v2-…`](PLAN-v2-2026-08-02-22_42.md),
[`SCHEMA-v2-…`](SCHEMA-v2-2026-08-02-22_42.md), [`SHARING-v2-…`](SHARING-v2-2026-08-02-22_42.md),
[`MIGRATION-v2-…`](MIGRATION-v2-2026-08-02-22_42.md), and the v1 set:
[`PLAN.md`](PLAN.md), [`SCHEMA.md`](SCHEMA.md), [`PROVISIONING.md`](PROVISIONING.md),
[`SHARING.md`](SHARING.md), [`MIGRATION.md`](MIGRATION.md).

## The one-paragraph version

The house is **`mem`**. Each member gets `mem.sessions_<member>`, `mem.messages_<member>`,
`mem.tool_calls_<member>` and three explicit grants over them `WITH GRANT OPTION`.
Isolation stops being a row policy that must be right everywhere and becomes a grant that
is simply absent — it fails closed. Sharing a whole room needs no operator. Team-wide
reads come from `Merge` rooms anchored on the room type (`^messages_`), which reduce to
each caller's own grants, auto-discover new members, and tolerate schema drift.
`user_id MATERIALIZED currentUser()` stays on every room: unforgeable **by members**, who
are not granted `EXECUTE AS`.

## Version history

**v3** — corrects v2's claim that ClickHouse has no impersonation. `EXECUTE AS` exists,
changes `currentUser()`, and is a grantable privilege denied to members by default. Two
consequences: the `user_id` guarantee is narrower than v2 stated (unforgeable by members,
not by the owner), and migration is no longer blocked on provenance.

**v2** — house renamed `memhouse` → `mem`; room naming flipped to type-first
(`messages_alice`), which removed v1's Merge self-match; migration deferred.

**v1** — first skeleton: the model, the grant collision finding, the Merge properties.

## Biggest open questions

1. **May members create and drop their own rooms?** It works and is safely scoped, but it
   lets a member drop their own memory and makes schema rollout non-central.
2. **Key order** — is `user_id` still worth an `ORDER BY` slot now the room is the tenant?
3. **Standalone path** — a user with no kernel is both owner and member; one credential or
   two?
4. **Is `EXECUTE AS` scopeable** to `mem.*` rather than `*.*`? Matters for migration and
   for how much the owner credential can do.
