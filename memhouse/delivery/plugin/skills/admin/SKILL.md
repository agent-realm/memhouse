---
name: admin
description: Operate the memhouse ClickHouse as its administrator — list and inspect every user and house, provision or remove members, grant and revoke access, and read server-wide health (disk, parts, mutations, running queries). Use when the user asks to "do X as admin", "manage users", "drop a house", "see disk usage", "who is on this server", or when a member-scoped skill refused for want of privileges. Requires an admin credential; says so plainly when there is not one.
user-invocable: true
argument-hint: "<what you want done>"
allowed-tools: Bash
---

# /mem:admin — operate the house as its administrator

A member owns one database. An **administrator** owns the ClickHouse: every house, every
account, every grant. This skill is the second one, and it is the only skill allowed to
act outside the caller's own house.

Everything here runs through the same rule as `/mem:invite`: **an admin password must
never enter this conversation.** memhouse ships this transcript into the house you are
administering, so a password pasted in chat is a password published to the archive.
Resolve it from the environment or a file, never from a prompt, and never echo it.

## 1. Find an admin credential — never ask for one in chat

Try these in order and stop at the first that works. **Never print any of these files or
the variables in them** — no `cat`, no `env | grep`, no `set -x`.

```bash
MH_HOME="${MEMHOUSE_HOME:-$HOME/.memhouse}"
# a) an explicit admin credential in the environment
ADM_U=${MEMHOUSE_ADMIN_USER-}; ADM_P=${MEMHOUSE_ADMIN_PASSWORD-}
# b) an admin env file kept beside the member config
if [ -z "$ADM_U" ] && [ -f "$MH_HOME/admin.env" ]; then
  set -a; . "$MH_HOME/admin.env"; set +a
  ADM_U=${MEMHOUSE_ADMIN_USER:-${MEMHOUSE_USER-}}; ADM_P=${MEMHOUSE_ADMIN_PASSWORD:-${MEMHOUSE_PASSWORD-}}
fi
# c) the ordinary member credential — on a house the pilot stood up themselves
#    (memhouse deploy --local) the member IS the superuser
set -a; [ -f "$MH_HOME/env" ] && . "$MH_HOME/env"; set +a
: "${ADM_U:=${MEMHOUSE_USER-}}"; : "${ADM_P:=${MEMHOUSE_PASSWORD-}}"
```

Then **prove** it is actually an admin rather than assuming — a member can often read
`system.users` while holding nothing else:

```bash
curl -sS --fail-with-body --user "$ADM_U:$ADM_P" \
  --data-binary "SHOW GRANTS FOR $ADM_U FORMAT TSV" "$MEMHOUSE_URL/"
```

Admin means the grants carry `ACCESS MANAGEMENT`, or `CREATE USER`/`CREATE DATABASE` at
`*.*` — not merely `SHOW USERS`, which every member has. If none of a/b/c qualifies,
**stop and say so**:

> This needs administrator access to the ClickHouse at `<url>`, and the credential
> configured here is the member account `<user>` — it owns its own house and nothing
> else. To use `/mem:admin`, put an admin credential in `~/.memhouse/admin.env`
> (`MEMHOUSE_ADMIN_USER=` / `MEMHOUSE_ADMIN_PASSWORD=`, mode 600) or export
> `MEMHOUSE_ADMIN_USER` / `MEMHOUSE_ADMIN_PASSWORD`, then ask again. Whoever operates
> the server has it; on a house from `memhouse deploy --local` it is the account already
> in `~/.memhouse/env`.

Do not offer to carry on with reduced powers, do not suggest the user paste a password
into the chat, and do not improvise around the refusal. Say which of a/b/c you tried.

## 2. Run the request

Use the resolved credential for every query. `--fail-with-body` so ClickHouse's own error
is visible; add `&readonly=1` on anything that only reads.

```bash
adm() { curl -sS --fail-with-body --user "$ADM_U:$ADM_P" --data-binary "$1" "$MEMHOUSE_URL/${2-}"; }
adm "SELECT …  FORMAT PrettyCompact" "?readonly=1"
```

Reads worth knowing — reach for these before inventing SQL:

| Question | Query |
|---|---|
| who exists | `SELECT name FROM system.users ORDER BY name` |
| what can someone do | `SHOW GRANTS FOR <user>` |
| every house and its size | `SELECT database, formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows FROM system.parts WHERE active GROUP BY database ORDER BY sum(bytes_on_disk) DESC` |
| a house's rooms | `SELECT table, formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows FROM system.parts WHERE active AND database = '<db>' GROUP BY table` |
| who writes where | `SELECT user_id, host, count() FROM <db>.messages GROUP BY user_id, host` |
| running queries | `SELECT query_id, user, elapsed, formatReadableSize(memory_usage) AS mem, substring(query,1,120) AS q FROM system.processes` |
| unfinished mutations | `SELECT database, table, mutation_id, command, parts_to_do, latest_fail_reason FROM system.mutations WHERE NOT is_done` |
| merge backlog | `SELECT database, table, elapsed, progress FROM system.merges` |

Writes follow the shapes memhouse itself uses, so an admin-made member is identical to an
invited one — a member gets `GRANT ALL ON <db>.* … WITH GRANT OPTION`, plus `SHOW USERS`,
self-scoped `ALTER USER`, `REMOTE`, and the async-insert pin. **Prefer the CLI over raw
SQL when one exists**: `memhouse invite <name> --url …` provisions a member correctly
(and refuses a house that already holds someone's messages); this skill is for the things
it does not cover.

## 3. Destructive work — look first, then confirm

`DROP DATABASE`, `DROP USER`, `REVOKE`, `ALTER … DELETE`, `TRUNCATE`, `KILL QUERY` and
password rotation all change something a person depends on. There are no backups and no
undo: a dropped house is gone, and the transcripts behind it may have aged out of the
editors that produced them.

Before any of them:

1. **Look at the target and report what is actually there** — row counts per room, who
   wrote them, the date span, which machines. A house you expected to be empty may not
   be.
2. **Name the collateral.** Dropping a user stops that account's shipper on every machine
   it runs on. Revoking a grant closes a share the other person may be mid-query on.
   Rotating a password breaks every machine shipping under it.
3. **Get an explicit yes for that specific object**, quoting the counts you just read.
   A general "yes do admin things" is not consent to drop a populated house.
4. **Verify afterwards** and say what is now true.

If the user has already told you exactly what to destroy and why, and the counts match
their description, proceed — do not re-litigate a decision they have made. Report the
outcome plainly, including the row counts destroyed.

## Never

Never accept an admin password typed into the conversation, and never print one — not in
a command, not in an echo, not in an error. If a command needs it, expand a shell
variable (`--admin-password "$ADM_P"`), so the value never appears in the transcript.

Never widen a member's grants beyond what `memhouse invite` issues without the user
asking for that specific privilege and being told what it allows. Never grant
`ACCESS MANAGEMENT`, `CREATE USER`, or anything at `*.*` casually — those make a second
administrator.

Never touch a house that is not the subject of the request. Never run a destructive
statement whose predicate you have not first run as a `SELECT`.
