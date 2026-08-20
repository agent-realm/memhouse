---
name: invite
description: Invite another person onto this memhouse ClickHouse — mint their user and their own house (database) with the right grants, producing the one env file their install needs. Use when the user says "invite X", "add X to memhouse", "get my friend set up". Inviting comes BEFORE sharing — /mem:share can only grant a user who exists.
user-invocable: true
argument-hint: "<name> [into <db>]"
allowed-tools: Bash
---

# /mem:invite — mint a member and hand them one file

This runs the `memhouse invite` CLI and nothing else. Inviting mints a ClickHouse user
and a house, which takes an ADMIN credential — and an admin password must never enter
this conversation, because memhouse ships the transcript into the house it just
provisioned. The CLI is the only safe path: the admin password is passed to one process
and never echoed. **Do not hand-run `CREATE USER` / `GRANT` with an admin password
substituted into a command — that burns the credential into the transcript on disk.**

## Do this

1. Confirm the `memhouse` binary is present: `command -v memhouse`. If it is not, tell
   the user to install it first (`npm install -g memhouse`) — there is no in-skill
   fallback, on purpose (see above).

2. Gather, by ASKING the user in chat:
   - the invitee's **name** (validate `[A-Za-z][A-Za-z0-9_]*`; refuse otherwise)
   - optionally the **house** to put them in (`into <db>`). If the user does not name
     one — or says "default"/"their own" — OMIT --db entirely; the CLI defaults the house
     to the invitee's name. Only pass --db when they name a SPECIFIC shared house (e.g.
     `team_a`). Never pass `--db default` for "the default house" — that is a literal
     database named default.
   - the **URL the invitee will reach the house at** — NOT localhost (that is the
     invitee's own machine). A LAN IP, hostname, or tunnel.
   - the **admin user name** (just the name).

3. Try it WITHOUT an admin password first — `memhouse invite` uses the caller's own
   configured credential when that credential can manage users (the common case for
   whoever set the house up):

   ```
   memhouse invite <name> --url <url> [--db <shared-house>]
   ```

   Run that via the Bash tool. If it succeeds (`invite written: …`), skip to step 4.

   If it fails with "your configured credential cannot create users", the caller's memhouse
   user is a plain member and provisioning needs a real admin. DO NOT take the admin
   password in chat — memhouse archives this transcript. Hand the user the line to run
   THEMSELVES (a leading space keeps it out of shell history):

   ```
   memhouse invite <name> --url <url> [--db <shared-house>] --admin-user <admin> --admin-password 'PASTE_IT_HERE'
   ```

4. When it succeeds it prints `invite written: invite-<name>.env`. Relay to the user:
   - hand `invite-<name>.env` to the invitee over a trusted channel (croc, a password
     manager — not chat); the file IS a password
   - the invitee runs `memhouse install --env invite-<name>.env` — it OFFERS to change
     the password to one only they know (they were granted rotation on their own account),
     then deletes the file; so the password you set stops working once they install
   - once installed, sharing works: `/mem:share <name>` on either side

## Never

Never create a ClickHouse user by running raw SQL with an admin password you were given
in chat. Never invent an admin credential. Never suggest granting beyond what `memhouse
invite` does. If the binary is absent, stop and say so — do not improvise the SQL.
