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

3. TRY IT BARE FIRST — run this via the Bash tool, from the directory the file should
   land in (step 4). `memhouse invite` uses the caller's OWN configured credential when
   it can manage users, which is the common case for whoever set the house up, so no
   admin is needed:

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

   **If it refuses with "house `<db>` already exists and holds N messages", STOP.** That
   house is somebody's memory, and inviting into it would hand the invitee someone else's
   sessions. Do not pass `--adopt` on your own initiative — report the row count and the
   writer count to the user and let them choose: a different handle, a different `--db`,
   or `--adopt` if sharing that house is genuinely what they want.

4. **Put the file where the user can attach it.** The CLI writes `invite-<name>.env`
   into the CURRENT directory, and the user has to send it by hand — so run the command
   from their downloads directory (on macOS and most Linux desktops `~/Downloads`), or
   move it there afterwards. Never leave it in a git repo: it is a password, and
   `invite-*.env` is only gitignored in this repo, not in whatever checkout the user
   happened to be standing in.

   Confirm it is there and still mode `600`, and say the full path. **Never print the
   file's contents** — the password inside would land in a transcript memhouse ships.

5. **Say whether the house was fresh.** Run
   `memhouse stats` or query `SELECT count() FROM <db>.messages` and tell the user
   plainly: a brand-new house reads 0. This is a second line of defence behind step 3's
   refusal, and it is how the user learns the invitee is starting clean.

6. **Write the message the user will send.** They are about to hand over a file plus an
   explanation, so compose it for them rather than making them write it. Put it in a
   fenced block they can copy whole, and cover:
   - what memhouse is, in a sentence or two — the invitee may never have heard of it
   - that the attached `invite-<name>.env` IS a password: don't forward it, don't paste
     it into chat
   - `npm install -g memhouse` (Node 24+, no flags, nothing compiles), then
     `memhouse install --env invite-<name>.env`
   - that install OFFERS to change the password to one only they know, then deletes the
     file — so they should say yes, because the inviter knows the current one
   - `memhouse onboard` to start shipping, `memhouse status` to check it worked
   - that their house is theirs alone; the inviter cannot read it unless they run
     `/mem:share <inviter>`

   If the invitee is REPLACING an existing setup (they were shipping under another
   credential), add `memhouse ship --full` after the install — a plain incremental pass
   skips sessions the new house has no record of, so their history would not follow them.

   Then: once installed, sharing works both ways — `/mem:share <name>`.

## Never

Never create a ClickHouse user by running raw SQL with an admin password you were given
in chat. Never invent an admin credential. Never suggest granting beyond what `memhouse
invite` does. If the binary is absent, stop and say so — do not improvise the SQL.

Never print the invite file's contents, and never pass `--adopt` unless the user asked
for it after being told what is already in that house.
