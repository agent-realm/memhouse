---
name: invite
description: Invite another person onto this memhouse ClickHouse — mint their user and their own house (database) with the right grants, and produce the one env file their install needs. Use when the user says "invite X", "add X to memhouse", "get my friend set up", "create a memhouse account for X". Inviting comes BEFORE sharing — /mem:share can only grant a user who exists.
user-invocable: true
argument-hint: "<name> [into <db>]"
allowed-tools: Bash
---

# /mem:invite — mint a member and hand them one file

The flow this produces: you give the resulting file to the person, they run
`memhouse install --env <file>`, done — their shipper builds their rooms in their own
house and starts archiving. Once they exist, `/mem:share <name>` works in both
directions. **Invite first, share second** — a share cannot create a user.

## Prefer the CLI when it is installed

```bash
memhouse invite <name> --url <house-url> --admin-user <a> --admin-password '<p>' [--db <db>] [--out <file>]
```

It does everything below in one verified step (including connecting AS the new member
before writing anything). Use the manual path only when the `memhouse` binary is not on
this machine.

## What this needs from the user — ask, never guess

1. **An admin credential** for the ClickHouse server. Ask for it in the conversation,
   use it for these statements only, never store it, never echo it back.
2. **The URL the INVITEE will reach the house at.** Not `localhost` — that is the
   invitee's own machine. A LAN IP, hostname, or tunnel address.

Validate the name and the db against `[A-Za-z][A-Za-z0-9_]*` and refuse anything else —
they are spliced into SQL unquoted, and a name that needs quoting will be gotten wrong
everywhere else too. The db defaults to the name (their own house); an existing shared
db (e.g. `team_a`) is also valid — that invites them INTO the shared house.

## The manual path (admin credential, one statement per request)

Generate a password without printing it into the chat:

```bash
PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)
```

Then, each as its own request (`curl -u "<admin>:<admin-pw>" --data-binary "<stmt>" "<url>/"`):

```sql
CREATE DATABASE IF NOT EXISTS <db>
CREATE USER IF NOT EXISTS <name> IDENTIFIED BY '<PW>'
GRANT ALL ON <db>.* TO <name>
GRANT SELECT ON <db>.* TO <name> WITH GRANT OPTION
ALTER USER <name> ADD SETTING async_insert = 0 CONST
```

Every piece is load-bearing: `ALL` on their own house is the tenancy model (reaches
nothing outside it), `SELECT … WITH GRANT OPTION` is what makes their `/mem:share`
self-serve (and stops at SELECT — they can hand on nothing more), and the async pin
keeps the server-stamped `user_id` honest.

Write the invite file (mode 600) — the values, not placeholders:

```bash
umask 077 && cat > invite-<name>.env <<EOF
# memhouse invite for '<name>' — THIS FILE IS A CREDENTIAL. Hand it over a trusted
# channel, delete after install, then rotate: memhouse passwd
MEMHOUSE_URL='<url>'
MEMHOUSE_USER='<name>'
MEMHOUSE_PASSWORD='$PW'
MEMHOUSE_DB='<db>'
EOF
```

## What to tell the user, verbatim in substance

- hand `invite-<name>.env` over a channel you trust — croc or a password manager, not
  chat; the file IS a password
- the invitee runs: `memhouse install --env invite-<name>.env`
- then they rotate, because YOU currently know their password:
  `memhouse passwd --admin-user … --admin-password …` (admin-assisted by design)
- after that, sharing works: `/mem:share <name>` on either side

## Never

Never create a user without an explicitly provided admin credential; never reuse a
credential found in a file the user did not name; never print the generated password
into the conversation (the file carries it); never grant beyond the five statements
above — `ALL ON *.*`, access management, or grants on someone else's house are not an
invite, whatever the request sounds like.
