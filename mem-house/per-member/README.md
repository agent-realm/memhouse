# per-member rooms — skeleton

A fork of the mem-house data model: **one house, a set of rooms per member**, instead of
one house with three rooms shared by everyone and separated by a row policy.

Nothing here is built. These are design skeletons with the decisions taken so far and the
open questions marked. The working design is still `../DESIGN.md` and `../schema.sql`.

This README is the living index; the design docs are versioned and never rewritten.

## Current — v4 (2026-08-02-22_58)

| File | What |
|---|---|
| [`PLAN-v4-2026-08-02-22_58.md`](PLAN-v4-2026-08-02-22_58.md) | the model, why, phases, measured facts |
| [`SCHEMA-v4-2026-08-02-22_58.md`](SCHEMA-v4-2026-08-02-22_58.md) | room naming, shapes, sort keys, Merge rooms, `sessions_v` as a saved query |
| [`PROVISIONING-v4-2026-08-02-22_58.md`](PROVISIONING-v4-2026-08-02-22_58.md) | the grant set, kernel capability, standalone path |
| [`SHARING-v3-2026-08-02-22_49.md`](SHARING-v3-2026-08-02-22_49.md) | whole-room self-serve, partial rows via the owner |
| [`MIGRATION-v3-2026-08-02-22_49.md`](MIGRATION-v3-2026-08-02-22_49.md) | **deferred**, and not blocked |

Superseded, kept as written: [v3 PLAN](PLAN-v3-2026-08-02-22_49.md) ·
[v3 SCHEMA](SCHEMA-v3-2026-08-02-22_49.md) · [v2 PLAN](PLAN-v2-2026-08-02-22_42.md) ·
[v2 SCHEMA](SCHEMA-v2-2026-08-02-22_42.md) ·
[v2 PROVISIONING](PROVISIONING-v2-2026-08-02-22_42.md) ·
[v2 SHARING](SHARING-v2-2026-08-02-22_42.md) ·
[v2 MIGRATION](MIGRATION-v2-2026-08-02-22_42.md) · v1: [PLAN](PLAN.md) ·
[SCHEMA](SCHEMA.md) · [PROVISIONING](PROVISIONING.md) · [SHARING](SHARING.md) ·
[MIGRATION](MIGRATION.md)

## The one-paragraph version

The house is **`mem`**. Each member gets `mem.sessions_<member>`, `mem.messages_<member>`,
`mem.tool_calls_<member>` and three grants over them `WITH GRANT OPTION`. Isolation stops
being a row policy that must be right everywhere and becomes a grant that is simply
absent — it fails closed. Sharing a whole room needs no operator. Team-wide reads come
from `Merge` rooms anchored on the room type (`^messages_`), which reduce to each caller's
own grants, auto-discover new members, and tolerate schema drift.
`user_id MATERIALIZED currentUser()` stays on every room: unforgeable by members, who are
not granted `EXECUTE AS`.

## Version history

**v4** — drops the wildcard-grant collision, which had been carried since v1 as a live
design constraint. Nothing in this design proposes a wildcard grant; the only wildcard is
the Merge regex, and it is anchored on a fixed room type. Also removes the handle-`_`
restriction that existed only to serve it.

**v3** — corrects v2's claim that ClickHouse has no impersonation. `EXECUTE AS` exists,
changes `currentUser()`, and is denied to members by default. The `user_id` guarantee is
narrower than v2 stated, and migration is not blocked on provenance.

**v2** — house renamed `memhouse` → `mem`; room naming flipped to type-first
(`messages_alice`), which removed v1's Merge self-match; migration deferred.

**v1** — first skeleton: the model, the Merge properties, the grant-collision finding
(now moot).

## Biggest open questions

1. **May members create and drop their own rooms?** It works and is safely scoped, but it
   lets a member drop their own memory and makes schema rollout non-central.
2. **Key order** — is `user_id` still worth an `ORDER BY` slot now the room is the tenant?
3. **Standalone path** — a user with no kernel is both owner and member; one credential or
   two?
4. **Is `EXECUTE AS` scopeable** to `mem.*` rather than `*.*`?
