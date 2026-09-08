---
name: access
description: Bring someone onto this memhouse ClickHouse, or let them read your house — mint a new member with their own house and the env file their install needs, grant a housemate read-only access to yours, list who can currently read it, or revoke. Use when the user says "invite X", "add X to memhouse", "get my friend set up", "share my memory with X", "let X see my sessions", "who can read my memory", "stop sharing with X". Inviting comes BEFORE sharing — you can only grant a user who already exists. Read-only by construction on the sharing side: a share can never let anyone write to or delete your memory.
user-invocable: true
argument-hint: "invite <name> | share <name> | list | revoke <name>"
allowed-tools: Bash
---

# /mem:access — who exists, and who may read

Two things that look alike and are not:

- **Invite** mints a ClickHouse *user* and their own *house*. Needs an administrator.
- **Share** grants an existing user `SELECT` on *your* house. You can do this yourself.

**Read `../reference/HOUSE.md` first** for the connection block. One rule dominates
everything here: **a password must never enter this conversation.** memhouse ships this
transcript into the house, and the archive is insert-only — a credential pasted here
cannot be withdrawn.

---

## Invite — mint a member

This runs the `memhouse invite` CLI and nothing else. **Do not hand-run `CREATE USER` /
`GRANT` with an admin password substituted into a command** — that burns the credential
into a transcript on disk. The CLI passes it to one process and never echoes it.

1. **Check the binary:** `command -v memhouse`. Absent → tell the user to
   `npm install -g memhouse`. There is no in-skill fallback, on purpose.

2. **Gather only two things:** the invitee's **name** (validate `[A-Za-z][A-Za-z0-9_]*`;
   refuse otherwise) and the **URL the invitee will reach the house at** — not localhost,
   which is *their* machine. Do not ask about an admin credential yet; the next step
   usually needs none. Default is their own house — omit `--db`.

3. **Run it from the directory the file should land in** (step 4), bare first:

   ```
   memhouse invite <name> --url <url> [--db <shared-house>]
   ```

   `invite written: …` → go to step 4, and no secret touched this conversation.

   Otherwise read WHICH refusal came back; they need different answers.

   **"cannot reach `<url>` …"** — the address, not your privileges. A `deploy --local`
   house is loopback-bound on purpose, so no LAN address reaches it and no invitee could
   either. Ask for the address the invitee will actually use; do not retry with a guess.

   **"`<user>` is a MEMBER of this ClickHouse, not an administrator"** — inviting needs
   `CREATE USER` and `CREATE DATABASE`, which a member deliberately lacks. Ask which case
   applies rather than assuming:

   - *They run the ClickHouse.* Hand them the line to run THEMSELVES, with
     `--admin-password` left OFF so it is prompted for — out of the process list and out
     of shell history:

     ```
     memhouse invite <name> --url <url> --admin-user <admin>
     ```

     **You cannot run that yourself:** the prompt needs a TTY your Bash tool lacks, so it
     refuses with "no TTY to prompt on" — and the fix is NOT `--admin-password`, which
     would put the credential in this transcript.

   - *Someone else runs it.* They cannot invite, and no flag changes that. Print the
     statements for whoever administers the server — this contacts nothing:

     ```
     memhouse invite <name> --url <url> --print-sql
     ```

   **"house `<db>` already exists and holds N messages"** — STOP. That house is somebody's
   memory. Report the row and writer counts and let the user choose: a different handle,
   a different `--db`, or `--adopt` if sharing that house is genuinely the intent. Never
   pass `--adopt` on your own initiative.

4. **Put the file where they can attach it.** The CLI writes `invite-<name>.env` into the
   current directory and the user sends it by hand — so run from their downloads
   directory, or move it there. **Never leave it in a git repo.** Confirm it is present
   and mode `600`, state the full path, and **never print its contents**.

5. **Say whether the house was fresh** — `SELECT count() FROM <db>.messages` reads 0 for a
   new one. Second line of defence behind step 3's refusal.

6. **Write the message the user will send.** `invite` wrote TWO files beside each other:
   `invite-<name>.env` (the credential, one-time) and `MEMHOUSE-INVITATION.md` (the steps,
   nothing secret — install, verify, what they own, things to try). The guide does the
   explaining, so the message is short: what memhouse is in a sentence; that the `.env` IS a
   password (do not forward, do not paste in chat); open `MEMHOUSE-INVITATION.md` and follow
   it. If `memhouse --version` shows a pre-release (a `-` in it), the invitee also needs the
   tarball this build came from (`memhouse nightly --out …`); the guide says so and names it.

   If they are REPLACING an existing credential, add `memhouse ship --full` — a plain
   incremental pass skips sessions the new house has no record of, so their history would
   not follow them.

---

## Share — let someone read your house

Sharing runs the `memhouse share` CLI. **Do not hand-write `GRANT` or `CREATE ROW POLICY`
for this** — partial sharing has four ways to go wrong quietly, and the command handles
each one:

```
memhouse share <user>                          everything you own
memhouse share <user> --only project=memhouse  just one project
memhouse share <user> --only session=<id>      just one conversation
memhouse share --list                          who can read it, and how much
memhouse share <user> --revoke                 withdraw
```

Scopes: `session=`, `project=`, `folder=`, `host=`, `source=`, `since=`, `until=`, and
they combine — `--only project=memhouse,since=2026-08-01`. Report back the counts it
prints (`2121 of 22488 rows`), because that is what the person will actually see.

**Say what a full share exposes** before running one: every session in the house, from
every machine, project and editor, including anything ever pasted into one. If that is
more than the user meant, `--only` is the answer, not a warning.

**Never widen without being asked.** Re-running `memhouse share <user>` with no `--only`
on someone currently scoped turns their partial share into a full one — the command says
so, and you should surface that line rather than let it pass.

### Why the CLI and not SQL

- A permissive catch-all policy for everyone else is the obvious design and it **fails
  open**: measured, a second scoped user saw all 22,500 rows instead of their 1,860.
- Partial sharing depends on `users_without_row_policies_can_read_rows`, which is server
  config, not a query setting, and whose default has moved between versions. The command
  measures the behaviour before creating the first policy and refuses on a server that
  would blindfold your existing readers.
- Revoking the grant alone leaves the policies behind, and a later re-share silently
  reinherits the old scope.
- A policy on `messages` but not `tool_calls` leaks. All three rooms move together.

If the command refuses because the server hides rows from unpolicied readers, relay its
message — a full share still works there; only `--only` is unavailable until an admin
sets that config.

## Never

Never accept a password typed into the conversation, and never print one. Never invent an
admin credential. Never suggest storing one on disk. Never grant beyond `SELECT` — write
access to your rooms is not a thing to hand out, and `ALL` would let the other side delete
your memory. If the binary is absent, stop and say so rather than improvising the SQL.
