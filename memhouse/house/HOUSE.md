# The house — a database, three shared rooms

**A house is a ClickHouse database.** Any database, named whatever its people name it —
`polat`, `team_a`, even `default`. Its rooms are three plain tables: `sessions`,
`messages`, `tool_calls`. There is nothing else to provision: no per-member tables, no
Merge rooms, no views, no settings profile.

**Everyone in the house writes into the same tables**, each with their own credential,
and two columns say where every row came from:

| Column | Meaning | Comes from |
|---|---|---|
| `user_id` | who wrote it | `String MATERIALIZED currentUser()` — stamped by the server, unforgeable by clients. `async_insert = 0 CONST` is pinned on each user (`ADD SETTING`, which merges — a bare `SETTINGS` clause replaces the user's whole list) because an async flush stores the stamp as the empty string (measured on 25.11.9.34) |
| `host` | which machine | the install's fingerprint (`../host.js`) — random, minted once, so two machines with the same hostname cannot collide and renaming one cannot split its history |

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

The model is **collaborative**: housemates trust each other with the house. Narrower
grants can be layered on later if a team wants them; the isolation mechanism between
groups that do NOT trust each other is a separate house.

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
keys, deliberately NOT in sessions'), the shipper's clear binds
`(session_id, user_id, origin='ship')`, and imported history survives every re-ship.
See the comments in `schema.sql.tpl` — they are the authority on the keys.
