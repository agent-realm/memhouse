# PROVISIONING — minting a member and their rooms

Two statements per room, six per member, and no seventh for the rollup: the session
rollup is a saved query over exactly these rooms, so a member who can read them can run
it. See [INSTALL.md](INSTALL.md) for the three ways this gets applied.

## A note on names before the SQL

The house is `mem`. `provision.js`, the shipper, the read layer and the CLI all default to
it, so the SQL below is what a default install actually provisions. The owner is
`memhouse_root` — the **database** was shortened to `mem`, the owning role was not.

They must agree or rooms get provisioned somewhere the product never reads. Override with
`MEM_DB` / `MEM_USER` (or the `MEMHOUSE_*` equivalents); `provision.js` prints the
connection it resolved so a mismatch is visible rather than silent.

An install predating this default carries `MEMHOUSE_DB` in `~/.memhouse/env`, and explicit
config outranks the default — so an existing `memhouse` house keeps working untouched.
Nothing migrates on upgrade.

## The grant set

Two statements per room. The split is the point.

```sql
GRANT ALL    ON mem.sessions_<m>   TO <m>;
GRANT SELECT ON mem.sessions_<m>   TO <m> WITH GRANT OPTION;
GRANT ALL    ON mem.messages_<m>   TO <m>;
GRANT SELECT ON mem.messages_<m>   TO <m> WITH GRANT OPTION;
GRANT ALL    ON mem.tool_calls_<m> TO <m>;
GRANT SELECT ON mem.tool_calls_<m> TO <m> WITH GRANT OPTION;
```

Plus `SELECT` on whichever Merge rooms exist, which is what makes the team room narrow to
the caller's own rooms instead of denying outright.

**`ALL`, not re-grantable.** The member owns their room outright — `DROP` and `TRUNCATE`
included, because it is their memory to destroy. It also covers the mutation privileges
below without naming them, which is what stops the version-dependent trap.

**`SELECT`, re-grantable.** A share is read-only **by construction**. `GRANT ALL … WITH
GRANT OPTION` expands to 45 privileges on 26.7 — `DROP TABLE`, `TRUNCATE`,
`CREATE ROW POLICY`, `SYSTEM DROP REPLICA` among them — every one of which a member could
then hand to a colleague while meaning "let them read my sessions". Measured on 26.7.2:
`GRANT SELECT … TO bob` succeeds, `GRANT DROP TABLE … TO bob` is refused 497, and the
member can still drop their own room.

Never `ON mem.*`. A member who can read `mem.*` can read every other member's rooms, and
then this is a shared house with longer table names.

### Why the mutation grants are not optional

v4 said `SELECT, INSERT`. A member provisioned that way ships **once** and then fails on
every subsequent pass.

Both `ALTER` privileges are needed, and **which one bites depends on the server version**.
`DELETE FROM` is a *lightweight* delete, implemented as
`ALTER TABLE ... UPDATE _row_exists = 0`: ClickHouse 26.7 refused it for want of
`ALTER DELETE`, and 25.11 refused the same statement for want of
`ALTER UPDATE(_row_exists)`. Granting the one you happened to test against produces a
member who cannot ship on the other server, so grant both.

The shipper is not append-only. A session file grows while the agent works, so each pass
re-parses the whole transcript and re-ships it; to keep that idempotent it **clears the
session's existing rows and re-inserts them**. `ReplacingMergeTree(ingested_at)` collapses
duplicates by key eventually, but it cannot remove a row the new parse no longer produces —
a re-parse that yields fewer rows would otherwise leave a stale `seq` tail behind forever.
So the clear is a real `ALTER TABLE ... DELETE`, and without the privilege the first
incremental pass dies with

```
Not enough privileges. To execute this query, it's necessary to have the grant
ALTER UPDATE(_row_exists) ON mem.messages_<m>
```

The failure is invisible in a first-run test, which is exactly why it survived four
document versions: provision, ship, count rows, declare victory. It only appears on the
*second* ship of a *changed* session.

### The delete predicate must bind the user, not call `currentUser()`

Related, and worse, because it fails **silently**. The clear was written as

```sql
DELETE FROM messages_<m> WHERE session_id = {id:String} AND user_id = currentUser()
```

A mutation does not evaluate `currentUser()` in the caller's context. Measured on
ClickHouse 25.11 and on chdb: the identical predicate with the literal value deleted 2000
rows where `currentUser()` deleted **0** — no error, no warning, nothing in the log. The
stale tail the delete exists to remove simply survives. The value is bound instead, read
from the server over the same connection, so it is the same identity with none of the
context dependence. This affected the **shared** layout too, and predates this fork.

### What the privilege lets a member do

Delete and mutate rows in their own rooms. That is their own memory, and they can already
overwrite it by re-shipping — so this widens what a member can destroy about themselves,
and nothing about anyone else. Grants remain per-room and explicit, so `ALTER DELETE` on
`messages_alice` says nothing about `messages_bob`.

`DROP TABLE` is included too (see below): a member can remove their own room, not just
empty it.

### Consequence of `WITH GRANT OPTION`

Grant-option covers every privilege **in the statement it is attached to**, which is why
it is attached to the `SELECT` statement and not the `ALL` one. Alice can hand bob read
access to `messages_alice` and nothing else; she cannot hand him the mutation or drop
rights even by mistake. The convention `SHARING` describes is now enforced by the engine
rather than by everyone remembering it.

A share is the three rooms and nothing else. The recipient runs the same rollup query over
them under their own credential, so there is no fourth grant to forget — which is the
concrete reason the query beat the view.

`WITH GRANT OPTION` is what makes whole-room sharing self-serve. Without it every share
becomes an operator ticket, which is most of the reason this fork exists.

The owner (`mem_root`) holds `ALL ON mem.* WITH GRANT OPTION`, so a second member joining
an existing house needs no new owner setup — house, owner, and Merge rooms are already
there.

**RESOLVED:** the member does get `CREATE TABLE` / `DROP TABLE` on their own rooms — it
is inside `ALL`. That is what lets `--ensure-schema` run as the member and makes the solo
install one command with no owner involvement. The cost is accepted: a member can drop
their own memory. The thing that was actually worth preventing — a member handing those
rights to someone else — is prevented by the grant-option split above.

## Kernel path

**Not finalized.** The realm holds the privileged credential and mints members; what the
installer asks it for and what it gets back is not designed yet.

What is settled regardless: the room layout, the grant set above, and the identity rule
(the ClickHouse user is the identity). What is open is only who plays admin and how the
handle is chosen. Whatever that turns out to be, provisioning wants to be ONE idempotent
step — three rooms plus their grants — because it is also the hook for rolling a schema
change across rooms.

Nothing touches the Merge rooms on member join: they are a regex over room names and
**auto-discover** rooms created after them.

## Standalone path

No kernel, so no capability layer; the CLI performs the same steps. `provision.js` is that
path today: it creates the house with a client that has *not* selected it (on a fresh
server the database does not exist yet, and selecting it fails before it can be created),
then the rooms, then the grants.

> **OPEN:** a standalone user is simultaneously owner and member. One credential holding
> both roles, or two? Today's `memhouse install` assumes a single credential that owns
> everything, which no longer maps cleanly.

## Row-policy rights

`GRANT ACCESS MANAGEMENT ON mem.*` expands to
`CREATE/ALTER/DROP/SHOW ROW POLICY ON mem.*` — house-scoped, no global access management
required. This is what lets the owner serve partial-share requests.

**Owner only.** The scope is the house, not a room, so any holder could attach a policy to
another member's rooms. Policies filter rather than grant, so it is not a data leak — but
it is a denial of service on a colleague's own reads.

## `EXECUTE AS`

Owner may hold it; **members must not**. It changes `currentUser()`, so a member holding
it could write rows stamped as someone else and defeat the provenance the schema relies
on.

## Not yet written

- the capability script
- member removal: drop the three rooms, revoke, and decide what happens to rooms they had
  shared outward
