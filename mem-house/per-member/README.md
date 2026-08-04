# per-member rooms

A fork of the mem-house data model: **one house, a set of rooms per member**, instead of
one house with three rooms shared by everyone and separated by a row policy.

**The design is implemented** — `rooms.js`, `provision.js`, the two DDL templates, room
routing through the read layer, and the `MEM_PER_MEMBER` switch — and proven end to end on
ClickHouse 26.7.1 and 25.11. The shared-room layout in `../DESIGN.md` and `../schema.sql`
still ships and is unchanged; per-member is opt-in.

| Document | What |
|---|---|
| [`PLAN.md`](PLAN.md) | the model, why, phases, measured facts |
| [`PROVISIONING.md`](PROVISIONING.md) | the grant set (three per member), kernel capability, standalone path |
| [`SCHEMA.md`](SCHEMA.md) | room naming, shapes, sort keys, Merge rooms, and why `sessions_v` is a saved query |
| [`SHARING.md`](SHARING.md) | whole-room self-serve (three grants), partial rows via the owner |

These four documents describe the design as it stands. Earlier revisions are in
`git log`, not in this directory — a superseded document kept beside the current one is a
contradiction waiting to be quoted, and this directory produced two review findings that
way before the versions were removed.

## The one-paragraph version

The house is **`mem`**. Each member gets `mem.sessions_<member>`, `mem.messages_<member>`,
`mem.tool_calls_<member>`, with three grants over them —
`SELECT, INSERT, ALTER UPDATE, ALTER DELETE`, all `WITH GRANT OPTION`. The session rollup
is a saved query over those same rooms, not a fourth object. Isolation stops
being a row policy that must be right everywhere and becomes a grant that is simply
absent — it fails closed. Sharing a whole room needs no operator. Team-wide reads come
from `Merge` rooms anchored on the room type (`^messages_`), which reduce to each caller's
own grants, auto-discover new members, and tolerate schema drift — provided the caller
holds `SELECT` on the Merge room itself, which provisioning issues; without it the team
room denies instead of narrowing.
`user_id MATERIALIZED currentUser()` stays on every room: unforgeable by members, who are
not granted `EXECUTE AS`.

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
6. **Is a saved rollup enough for agents?** It has no name to type. `memhouse
   sessions-query` prints it, which is a worse affordance than a name and the price of
   having nothing to own, grant or collide.
