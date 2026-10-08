# The house — a database, and the rooms in it

**A house is a ClickHouse database.** Any database, named whatever its people name it —
`polat`, `team_a`, even `default`. Its rooms are tables: `sessions`, `messages`,
`tool_calls`. No views, no Merge rooms, no settings profile.

**Every member's rooms are named for them, and one grant covers them.** `mem.polat_*`
for polat, `mem.alice_*` for alice, in the same database — `mem` unless somebody has a
reason. The grant is `GRANT … ON mem.polat_* TO polat WITH GRANT OPTION`: it lets the
member create and rebuild their own rooms, share them, and reach nothing else. Nobody is
granted the database itself. A house with one member is a house of one, not a different
kind of house — a colleague joins as one more member and nothing about the first changes.
`roomNames()` in `house.js` is the only place a table name is produced.

Two columns say where every row came from:

| Column | Meaning | Comes from |
|---|---|---|
| `user_id` | who wrote it | `String MATERIALIZED currentUser()` — stamped by the server, unforgeable by clients. `async_insert = 0 CONST` is pinned on each user (`ADD SETTING`, which merges — a bare `SETTINGS` clause replaces the user's whole list) because an async flush stores the stamp as the empty string (measured on 25.11.9.34) |
| `host` | which machine | the machine's fingerprint (`../host.js`) — derived from the OS machine id (random only where none can be read), so two machines with the same hostname cannot collide and renaming one cannot split its history |

`WHERE user_id = 'alice'` is one person. `WHERE host = 'macbook-4127a95b'` is one
machine. No filter is the whole house — which is what a team dashboard wants.

## Joining a house

The whole tenancy model is the database boundary:

```sql
CREATE USER alice IDENTIFIED BY '…';
GRANT ALL ON team_a.* TO alice;
ALTER USER alice ADD SETTING async_insert = 0 CONST;
```

`ALL` on your own house reaches nothing outside it, and it is what lets alice's own
shipper create and evolve the rooms (`ship.js --ensure-schema`) — no admin has to run
memhouse code. Joining a ClickHouse that happens to run a kernel is the same three
statements: a database and a credential, nothing else.

**Housemates do not have to trust each other with the house.** They used to: everyone
held `ALL` on the database, and the isolation mechanism between parties who should not
see each other was a separate house. That shape leaked — one member could `GRANT SELECT
ON db.* TO <outsider>` and hand over a housemate's transcripts, with no admin and no
notification.

In a shared house each member is granted their own rooms and nothing else, so isolation
lives INSIDE one house and is checkable: `SHOW GRANTS` lists what you hold, and `SHOW
TABLES` does not list what you do not. A separate house is still the boundary between
groups that should not even know of each other — names leak across a shared house even
when content does not.

## One user on two machines, same session id

Session ids are minted per machine, so this needs a synced home directory to happen at
all — but when it does (the same `~/.claude` on two synced machines), both shippers ship
the same `(session_id, user_id)`. The keys deliberately do NOT include `host`, so the
rows collapse to the LAST shipper's copy: one logical session stays one session, with
`host` recording who shipped it most recently. Keying on host instead would duplicate
every such session and double what the rollup counts. Two shippers interleaving can no
longer drop rows — neither of them deletes anything — but they can disagree about the
epoch and fork a session that did not change; the next pass settles it. Truly parallel
shippers per user are the deferred "ephemeral fingerprint" expert feature, not today's.

## The rollup is a saved query, not an object

`sessions_v` is SQL text (house.js `sessionsRollup`), substituted into the same
`FROM … AS c` position a view name would occupy and run under the caller's own
credential. It groups by `(session_id, user_id)` — two housemates' rows never merge,
even on a colliding session_id — and carries its own `FINAL` and
`SETTINGS join_use_nulls = 1`, so it is correct wherever it is pasted.

## What this replaced, and why

The per-member layout: rooms named `sessions_<member>` with a narrowed per-member grant
set, Merge rooms (`all_sessions`…) for team reads, and isolation between members of one
database. Retired because every piece of it was cost paid for an adversarial model the
product does not have:

- suffixed names made every client resolve its room names before writing SQL, and
  `FROM messages` a documented trap the acceptance suite had to test for;
- the Merge rooms existed only to undo the splitting the suffixes created;
- the narrowed grant set existed to stop housemates attacking each other — but
  housemates are collaborators, and groups that are not do not share a database.

The origin story that survives: rows carry `origin` (in the messages/tool_calls sorting
keys, deliberately NOT in sessions'), so ReplacingMergeTree cannot collapse an imported
row against a shipped one and imported history survives every re-ship.

## One session, more than one parse

`messages` and `tool_calls` also key on `epoch`. The shipper is insert-only: when a
re-parse is SHORTER than what the house holds, or differs from it at a `seq` the house
already has, it writes the new parse under `epoch + 1` and leaves the old one intact.
Both are ordinary — Claude Code compacts a transcript in place and deletes it after
`cleanupPeriodDays` (30 by default), so the house is routinely the only surviving copy.
An unchanged re-ship reuses the epoch and costs nothing.

Reads must therefore take the newest epoch per `(session_id, user_id)` for `origin='ship'`
rows and leave every other origin alone (an import sits at epoch 0 forever). Nobody writes
that filter by hand: `roomNames()` resolves `messages` and `tool_calls` to a subquery that
already applies it, and hands out the bare tables only as `messages_raw` / `tool_calls_raw`
for writes and DDL.

## The house's own record

Two tables that are not rooms:

- `meta` — house-wide key/value, latest-wins: `schema_version`, and the memhouse
  version each member last shipped with.
- `events` — append-only: migrations (`pending` → `applied` | `failed`), version
  changes, schema observations, each with actor, host and row counts. Nothing is updated
  in place, so a migration that failed and was retried reads as exactly that.

What lives there is what `system.tables` and `system.users` cannot say — intent, sequence,
outcome. Which rooms and users exist is read live from `system.*`, never mirrored.

Sorting keys cannot be altered, so a schema generation change is a room rebuild:
`memhouse migrate-rooms` copies each room into one with the current key, swaps it in with
a single `RENAME`, and keeps the old room as `<room>_pre_epoch`. It deletes nothing and
carries `user_id` across explicitly, so a housemate's rows are not restamped as the
migrator's.

See the comments in `schema.sql.tpl` — they are the authority on the keys.
