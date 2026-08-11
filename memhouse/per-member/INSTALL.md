# INSTALL — how a house gets a member

Three options. The first two are finished and measured; the third is not.

| | you hold admin | who runs the SQL | admin credential |
|---|---|---|---|
| **1. print the SQL** | yes | you | never leaves your terminal |
| **2. hand it over** | yes | the installer | used, then discarded |
| **3. kernel** | no — the realm does | not finalized | — |

## The identity rule, first — everything else follows from it

**The ClickHouse user is the identity.** Rooms are `sessions_<member>`,
`messages_<member>`, `tool_calls_<member>`, and `<member>` is whatever the server answers
to `SELECT currentUser()` — never what the config file says, never what the OS says.

The home directory produces a **suggestion**:

```
/Users/polat          -> polat
/Users/ramazan.polat  -> ramazan_polat     (sanitized, and the change is printed)
/home/JohnSmith       -> JohnSmith         (case preserved; ClickHouse is case-sensitive)
/root                 -> refused           (a container artefact, not a person)
```

Sanitization is `[A-Za-z][A-Za-z0-9_]*`. It can collide — `ramazan.polat` and
`ramazan-polat` both land on `ramazan_polat` — so a changed suggestion is printed, and
`--member` overrides it.

## Option 1 — print the SQL, run it yourself

The common case: you installed ClickHouse, you have `default` with
`access_management = 1`, and you would rather run four kinds of statement than hand a
superuser credential to an installer.

```
memhouse install --print-sql [--member polat] [--db mem]
```

Prints the whole install as SQL and exits. Nothing is contacted, nothing is written. It
generates a password and prints it inside the `CREATE USER`, or takes `--member-password`.
The last line is the command to run afterwards, with the credential filled in.

Two properties that make the block safe to paste anywhere:

- **Every name is qualified and there is no `USE`.** It runs in `clickhouse-client`, the
  play UI, `curl`, or a GUI, in any database context.
- **The Merge engine gets the literal house name, not `currentDatabase()`.** That call is
  evaluated at CREATE time, not read time, so a block run without the house selected would
  otherwise build Merge rooms pointing at `default` that return zero rows forever, with no
  error at any point.

Measured: 18 statements (the 17 objects plus a leading `SET
allow_experimental_full_text_index = 1`), run over HTTP with no database selected, 18
succeeded on both 26.7.2.59 and 25.11.9.34, and the
Merge rooms came out bound to `Merge('mem', '^sessions_')`.

## Option 2 — give the installer admin, it runs the SQL

```
memhouse install --admin-user … --admin-password … [--member polat]
```

The same statements, applied by `provision.js` so there is one implementation of the grant
set rather than two that drift. Then the step that makes the mode trustworthy:
**disconnect from admin, reconnect as the member, and prove that credential reaches all
three rooms before writing anything.** A mode that only proves the admin could do it has
proven nothing about the credential it is about to persist.

**The admin credential is never persisted** — not to the env file, not to a unit file, not
to a log. A shipper running as the house owner would make per-member rooms decoration.

## Option 3 — the kernel

**Not finalized.** The realm holds the privileged credential and mints members; what the
installer asks it for, and what it gets back, is not designed yet. Everything above about
the room layout, the grant set and the identity rule holds regardless — what is open is
who plays admin and how the handle is chosen.

## The grant set — two statements per room, and the split is the point

```sql
GRANT SELECT, INSERT, ALTER UPDATE, ALTER DELETE, ALTER ADD COLUMN, OPTIMIZE
             ON mem.sessions_polat TO polat;
GRANT SELECT ON mem.sessions_polat TO polat WITH GRANT OPTION;
```

**Exactly what the shipper uses, not `ALL`.** `ALL` expands to 45 privileges on 26.7 and
one of them is `CREATE TABLE` **on the member's own room name** — so the member owns the
NAME, not just the data, and can do this:

```sql
DROP TABLE messages_polat;
CREATE TABLE messages_polat AS all_messages ENGINE = Merge('mem','^messages_');
```

`all_messages` is `Merge(mem,'^messages_')`, so it then contains a Merge over its own
namespace and **every other member's rows are counted twice in the team room**. Measured:
a house reading alice 6030 / bob 2401 / carol 12 became bob 4802 / carol 24, with no error
on either ClickHouse version. Confidentiality survives — the Merge still narrows by grants,
so nothing new becomes readable — but a team-wide number is what that room is for.

`ALTER UPDATE` and `ALTER DELETE` are both named because `DELETE FROM` is a lightweight
delete implemented as `ALTER TABLE … UPDATE _row_exists = 0`, and which of the two a server
demands varies by version (25.11 wants one where 26.7 wanted the other). `ALTER ADD COLUMN`
is for `ensureSchema`'s rollout. Replacing a room is the admin's job, not the member's.

**`SELECT`, re-grantable.** A share is read-only **by construction**, not by convention:
the member can hand a colleague `SELECT` and nothing else, because they hold nothing else
to hand over.

Measured on 26.7.2 and 25.11.9:

```
polat grants SELECT to bob      ok
polat grants DROP TABLE to bob  497 Not enough privileges
polat drops their own room      497 Not enough privileges
polat creates any table         497 Not enough privileges
polat installs, ships, resets   ok
bob ends up with                GRANT SELECT ON mem.sessions_polat
```

One definition, in `rooms.js` as `MEMBER_PRIVS`, used by both `provision.js` and
`install --print-sql`. They drifted once — the first was narrowed and the second went on
emitting `GRANT ALL` for a release, so the attack above stayed reachable through the path
this document calls the common case.

Never `ON mem.*`. A member who can read `mem.*` can read every other member's rooms, and
then this is a shared house with longer table names.

`SELECT` on the three Merge rooms is granted broadly and is safe: a Merge table reduces to
the underlying rooms the *caller* holds grants for, so it narrows rather than denies, and
picks up members added later with no DDL.

## Refusals — the complete list

Install refuses, names both sides, and creates nothing:

| Case | Why |
|---|---|
| handle does not match `[A-Za-z][A-Za-z0-9_]*` after sanitization | it would need quoting, and a quoted room name breaks the Merge selectors |
| handle would be `root`, or the home directory is `/root` | a container artefact, not a person |
| **option 2: the ClickHouse user already exists** | the second human would take over the first's identity and rooms, and `user_id MATERIALIZED currentUser()` would stamp them identically. Requires `--adopt-user` AND `--member-password`, verified by reconnecting before anything is written |
| option 2: `mem` absent and admin cannot `CREATE DATABASE` | nothing downstream can work |
| an env file already points at a different url/db | it would orphan a running shipper. `memhouse setup` is the deliberate way to move; `--force` overrides |
| rooms missing and you cannot create them | you are not the owner — both other options are printed |

`--adopt-user` is legitimate — the same person on a new laptop — but it is
indistinguishable from a takeover without the password, so the password is the proof.

## After install — when admin is needed again

- **a second member** — `provision.js --member <name> --merge`, or `--print-sql --member <name>`
- **schema rollout** — `ADD COLUMN` on the **Merge room first**, then the member rooms;
  Merge rejects mutations and tolerates drift, which is what makes a progressive rollout
  possible
- **offboarding** — `DROP USER <member>`. The rooms are deliberately left: they hold that
  person's transcripts, and deleting someone's memory is a decision, not a cleanup step

## Upgrading from 0.3.x — read this before you do

**0.4.0 cannot read a 0.3.x house.** An earlier version of this document said an existing
house "keeps working untouched". That was wrong, and it was wrong in the release notes and
the `v0.4.0` tag message too.

What is true: the DATABASE NAME survives. `MEMHOUSE_DB` sits in `~/.memhouse/env` and
explicit config outranks the new `mem` default, so nothing repoints you at a different
house. What does not survive is the TABLES. 0.3.x kept `sessions`, `messages`,
`tool_calls` and a stored `sessions_v`; 0.4.0 looks for `sessions_<you>` and finds nothing.
Measured against a real 0.3.2 house:

```
memhouse status  ->  not connected: Code: 60 ... Unknown table expression
                     identifier 'sessions_memhouse_root'
memhouse doctor  ->  schema: 0/3 rooms in 'memhouse'
memhouse ship    ->  pass failed: UNKNOWN_TABLE
```

`install` and `doctor` now detect this and name it, rather than telling you to run an
install you already ran.

**Your transcripts are not lost.** memhouse ships FROM your local session stores, so the
new rooms rebuild from disk and the old tables are left untouched:

```
memhouse install --admin-user <user> --admin-password <pw> --member <you>
memhouse ship --full
```

The one thing that does not come back that way is a session whose transcript you have
since deleted locally — it exists only in the old tables. Read those before dropping
anything: `SELECT * FROM <db>.sessions`.

## Where the credential lives

`~/.memhouse/env`, mode 0600, `MEMHOUSE_*` keys. **Not** a `.env` in a working directory:
the skills and docs source this path (`. ~/.memhouse/env`), and a `.env` beside a checkout
gets committed eventually.

The env file is written **last**, after everything above has proved out. Written first, a
failed install leaves a config behind that the next command reads as truth.

`memhouse service install` inlines the same values into the unit file, because a service
must not depend on a shell-quoted file it does not parse the same way. That is a second
copy, also 0600, removed by `memhouse service uninstall`.

## `--adopt-user` needs house admin — it is not the new-machine path

`--adopt-user` is read only on the `--admin-user` branch, so it provisions a member and
requires admin on the house. Passing it without `--admin-user` used to be ignored silently;
it is refused now.

The actual "same person, new machine" path needs no admin at all — you already have a
member credential, so just use it:

    memhouse install --url https://… --user <member> --password …

That finds the existing rooms and writes the config. `--adopt-user` is for the case where
an admin is *creating or re-attaching* a member and wants the existing password verified
before anything is written.

## Offboarding, from the member's side

`DROP USER <member>` leaves their rooms and revokes everything (verified: no orphan grants
survive). From that member's machine every command then fails with `AUTHENTICATION_FAILED`
and advises reinstalling — which cannot work, and is indistinguishable from a wrong
password. There is no signal that says "you were offboarded"; ClickHouse does not
distinguish the two either. Worth knowing before you use it on someone.
