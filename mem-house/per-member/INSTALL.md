# INSTALL — how a house gets a member

Two modes, chosen by one question: **do you hold admin on this ClickHouse?**

The kernel is not a third mode. It is mode B with the ego supplying the admin credential
and the realm supplying the handle. See the last section.

## The identity rule, first — everything else follows from it

**The ClickHouse user is the identity.** Rooms are `sessions_<member>`,
`messages_<member>`, `tool_calls_<member>`, and `<member>` is whatever the server answers
to `SELECT currentUser()` — never what the config file says, never what the OS says.

The home directory only produces a **suggestion**:

```
/Users/polat          -> polat
/Users/ramazan.polat  -> ramazan_polat     (sanitized, and the change is printed)
/home/JohnSmith       -> JohnSmith         (case preserved; ClickHouse is case-sensitive)
/root                 -> refused           (see refusals)
```

Sanitization is `[A-Za-z][A-Za-z0-9_]*`: anything else becomes `_`, a leading non-letter is
refused rather than patched. Sanitizing can collide — `ramazan.polat` and `ramazan-polat`
both land on `ramazan_polat` — so the suggestion is **shown and confirmable**, and
`--member` overrides it. Under `--yes` the suggestion is used and printed on its own line.

A local single-user house may as well use the ClickHouse `default` user; that is a
`--member default` install and everything below still holds.

## Mode A — you have a member credential (the default)

Someone already provisioned you. You have a URL, a username, a password.

```
memhouse install --url … --user … --password … [--db mem]
```

1. Connect. Fail here and nothing else runs.
2. `SELECT currentUser()` — this, not `--user`, names the rooms. They differ under LDAP
   mapping and role defaults; if they differ, install says so once and uses
   `currentUser()`.
3. Do all three rooms exist?
   - **yes** → done.
   - **no** → try to create them as yourself. On a house you own this succeeds and mode A
     *is* the solo install: one command, no admin, no second party.
   - **still no** (you hold no `CREATE TABLE`) → print the exact command the owner must
     run, with your handle already substituted, and exit 1.
4. Write `~/.memhouse/env`, mode 0600, with **your** credential.

## Mode B — you have admin, and want it to build everything

```
memhouse install --admin-user … --admin-password … [--member polat] [--member-password …]
```

Five verbs, in this order, each idempotent:

1. `CREATE DATABASE IF NOT EXISTS mem`
2. `CREATE USER <member> IDENTIFIED BY <password>`
3. the three rooms, from `schema-member.sql.tpl`
4. `GRANT SELECT, INSERT, ALTER UPDATE, ALTER DELETE ON mem.<room> TO <member> WITH GRANT OPTION` — one statement per room
5. the three Merge rooms, and `GRANT SELECT` on them to the member

Then — and this is the step that makes the mode trustworthy — **disconnect from admin,
reconnect as the member, and re-run mode A's check.** Only if that passes is
`~/.memhouse/env` written, and it is written with the **member** credential.

**The admin credential is never persisted.** Not to the env file, not to a unit file, not
to a log. It is used for the five verbs and dropped. A shipper running as the house owner
would make per-member rooms decoration.

If `--member-password` is absent, install generates 32 random characters and prints them
once, before writing anything. There is no second chance to read it; there is
`ALTER USER … IDENTIFIED BY` to set a new one.

### The grant set is exactly this, and no wider

Four privileges, on **the member's own three rooms**. Never `ON mem.*`. A member who can
read `mem.*` can read every other member's rooms, and then the layout is a shared house
with extra table names. `WITH GRANT OPTION` is what makes sharing self-serve, and applies
only to rooms they own.

`SELECT` on the Merge rooms is safe to grant broadly: a Merge table reduces to the
underlying rooms the *caller* holds grants for, so it narrows rather than denies, and
auto-discovers members added later.

## Refusals — the complete list

Install refuses, names both sides, and creates nothing:

| Case | Why |
|---|---|
| handle does not match `[A-Za-z][A-Za-z0-9_]*` after sanitization | it would need quoting, and a quoted room name breaks the Merge selectors |
| handle would be `root`, or the home directory is `/root` | that is a container artefact, not a person |
| **mode B: the ClickHouse user already exists** | the second human would take over the first's identity and rooms, and `user_id MATERIALIZED currentUser()` would stamp them identically. Requires `--adopt-user` AND `--member-password`, which is then verified by reconnecting before anything is written |
| mode B: `mem` absent and admin cannot `CREATE DATABASE` | nothing downstream can work |
| an env file already points at a different url/db | it would orphan a running shipper against the old house. `memhouse setup` is the deliberate way to move |
| mode A: rooms missing and cannot be created | you are not the owner; the owner's command is printed |

The `--adopt-user` case is the one worth stating out loud: adoption is legitimate — a
person reinstalling on a new laptop — but it is indistinguishable from a takeover without
the password, so the password is the proof.

## After install — who still needs admin

Install is not the end of the owner's job. Admin is required again for exactly three
things, and install prints this once:

- **a second member** — `provision.js --member <name> --merge`
- **the Merge rooms**, if a solo install skipped them (mode A creating its own rooms does)
- **schema rollout** — `ADD COLUMN` on the **Merge room first**, then the member rooms;
  Merge rejects mutations and tolerates drift, which is what makes a progressive rollout
  possible

**Offboarding** is `DROP USER <member>`. The rooms are deliberately left: they hold that
person's transcripts, and deleting someone's memory is a decision, not a cleanup step. An
owner who wants them gone drops the three tables explicitly.

## Where the credential lives

`~/.memhouse/env`, mode 0600, `MEMHOUSE_*` keys. **Not** a `.env` in a working directory:
the skills and docs source this path (`. ~/.memhouse/env`), and a `.env` beside a checkout
gets committed eventually.

`memhouse service install` inlines the same values into the unit file, because a service
must not depend on a shell-quoted file it does not parse the same way. That is a second
copy of the credential, at 0600, and `memhouse service uninstall` removes it.

## The kernel

Not a third flow — **mode B with two parameters swapped**:

- the admin credential is the **ego** (the `kernel` ClickHouse user), which already holds
  ACCESS MANAGEMENT; the human never sees it
- the handle comes from the realm's member registry, not the home directory

The five verbs are the same five verbs. The reconnect-as-member check is the same check.
What the kernel adds is that step 2 is a `register-member` capability rather than a raw
`CREATE USER`, and that the mayor approves the install. Nothing about the room layout,
the grant set, or the refusals changes.
