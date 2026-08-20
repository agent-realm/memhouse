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

2. Gather ONLY two things by asking:
   - the invitee's **name** (validate `[A-Za-z][A-Za-z0-9_]*`; refuse otherwise)
   - the **URL the invitee will reach the house at** — NOT localhost (that is the
     invitee's own machine). A LAN IP, hostname, or tunnel.

   Do NOT ask for an admin user or password yet — the next step usually needs neither.
   Only ask about a **shared house** if the user brings one up; default is the invitee's
   own house (omit --db; never pass `--db default` for "the default house").

3. TRY IT BARE FIRST — run this via the Bash tool. `memhouse invite` uses the caller's
   OWN configured credential when it can manage users, which is the common case for
   whoever set the house up, so no admin is needed:

   ```
   memhouse invite <name> --url <url> [--db <shared-house>]
   ```

   If it prints `invite written: …`, go to step 4 — you are done, and no admin secret
   ever touched this conversation.

   ONLY if it fails with "your configured credential cannot create users" does
   provisioning need a real admin. Do NOT take the admin password in chat — memhouse
   archives this transcript. Hand the user the line to run THEMSELVES (a leading space
   keeps it out of shell history):

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
