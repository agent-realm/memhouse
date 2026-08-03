# per-member rooms

A fork of the mem-house data model: **one house, a set of rooms per member**, instead of
one house with three rooms shared by everyone and separated by a row policy.

v1–v4 were design skeletons. **The design is now implemented** — `rooms.js`,
`provision.js`, the two DDL templates, room routing through the read layer, and the
`MEM_PER_MEMBER` switch — and proven end-to-end on ClickHouse 26.7.1 and 25.11. The
shared-room layout in `../DESIGN.md` and `../schema.sql` still ships and is unchanged;
per-member is opt-in.

This README is the living index; the design docs are versioned and never rewritten.

## Current — v5 (2026-08-03-16_01)

| File | What |
|---|---|
| [`PLAN-v5-2026-08-03-16_01.md`](PLAN-v5-2026-08-03-16_01.md) | the model, why, phases, measured facts |
| [`PROVISIONING-v5-2026-08-03-16_01.md`](PROVISIONING-v5-2026-08-03-16_01.md) | the grant set, kernel capability, standalone path |
| [`SCHEMA-v4-2026-08-02-22_58.md`](SCHEMA-v4-2026-08-02-22_58.md) | room naming, shapes, sort keys, Merge rooms (its `sessions_v`-as-a-saved-query section is superseded by v5: it is a stored view per member) |
| [`SHARING-v4-2026-08-03-17_02.md`](SHARING-v4-2026-08-03-17_02.md) | whole-room self-serve (four grants, including the view), partial rows via the owner |
| [`MIGRATION-v3-2026-08-02-22_49.md`](MIGRATION-v3-2026-08-02-22_49.md) | **deferred**, and not blocked |

Superseded, kept as written: [v3 SHARING](SHARING-v3-2026-08-02-22_49.md) ·
[v4 PLAN](PLAN-v4-2026-08-02-22_58.md) ·
[v4 PROVISIONING](PROVISIONING-v4-2026-08-02-22_58.md) ·
[v3 PLAN](PLAN-v3-2026-08-02-22_49.md) ·
[v3 SCHEMA](SCHEMA-v3-2026-08-02-22_49.md) · [v2 PLAN](PLAN-v2-2026-08-02-22_42.md) ·
[v2 SCHEMA](SCHEMA-v2-2026-08-02-22_42.md) ·
[v2 PROVISIONING](PROVISIONING-v2-2026-08-02-22_42.md) ·
[v2 SHARING](SHARING-v2-2026-08-02-22_42.md) ·
[v2 MIGRATION](MIGRATION-v2-2026-08-02-22_42.md) · v1: [PLAN](PLAN.md) ·
[SCHEMA](SCHEMA.md) · [PROVISIONING](PROVISIONING.md) · [SHARING](SHARING.md) ·
[MIGRATION](MIGRATION.md)

## The one-paragraph version

The house is **`mem`**. Each member gets `mem.sessions_<member>`, `mem.messages_<member>`,
`mem.tool_calls_<member>` and their own `mem.v_sessions_<member>`, with four grants over
them: `SELECT, INSERT, ALTER UPDATE, ALTER DELETE` on the three rooms and `SELECT` on the
view, all `WITH GRANT OPTION`. Isolation stops
being a row policy that must be right everywhere and becomes a grant that is simply
absent — it fails closed. Sharing a whole room needs no operator. Team-wide reads come
from `Merge` rooms anchored on the room type (`^messages_`), which reduce to each caller's
own grants, auto-discover new members, and tolerate schema drift — provided the caller
holds `SELECT` on the Merge room itself, which provisioning issues; without it the team
room denies instead of narrowing.
`user_id MATERIALIZED currentUser()` stays on every room: unforgeable by members, who are
not granted `EXECUTE AS`.

## Version history

**v5** — three corrections found by running the thing, not by rereading it. The grant set
needs both `ALTER UPDATE` and `ALTER DELETE`, not just `SELECT, INSERT`; which of the two
a server demands varies by version, and the error only appears on the *second* ship of a
*changed* session, which is how four document versions carried it. The delete predicate
must **bind** the user rather than call `currentUser()`, which in a mutation matches
nothing and removes nothing, silently. And each member needs their own `sessions_v`,
because the dashboard and CLI read the view rather than the rooms — without it a
per-member house ships fine and reads back nothing. That view is named `v_sessions_<m>`,
**prefixed rather than suffixed**: `sessions_v_<m>` would sit inside the `^sessions_`
namespace the Merge rooms select on, and `all_sessions` would try to merge an aggregate
view into the base session rooms. Also stops calling this a skeleton: it is implemented
and measured.

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
5. **Should a share be `SELECT`-only?** Grant-option covers the whole grant, so a member can
   hand a colleague the mutation rights on their own room. Convention says read-only; nothing
   enforces it.
