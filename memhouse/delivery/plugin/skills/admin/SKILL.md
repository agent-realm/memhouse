---
name: admin
description: Operate the memhouse ClickHouse as its administrator — list and inspect every user and house, provision or remove members, grant and revoke access, and read server-wide health (disk, parts, mutations, running queries). Use when the user asks to "do X as admin", "manage users", "drop a house", "see disk usage", "who is on this server", or when a member-scoped skill refused for want of privileges. Requires an administrator credential in the environment; says so plainly, and how to supply one, when there is not.
user-invocable: true
argument-hint: "<what you want done>"
allowed-tools: Bash
---

# /mem:admin — operate the house as its administrator

A member owns one database. An **administrator** owns the ClickHouse: every house, every
account, every grant. This skill is the second one, and it is the only skill allowed to
act outside the caller's own house.

**Read `../reference/HOUSE.md` first** — connection, schema, and the traps every query
here inherits.

**An admin password must never enter this conversation.** memhouse ships this transcript
into the house you are administering, so a password pasted here is a password published
to the archive — and unlike a file you can delete, the archive is insert-only. Resolve
the credential from the environment or refuse. Never ask for one in chat, never echo one,
never write one to a file.

## 1. Ask the CLI what you are holding — do not work it out yourself

```bash
memhouse whoami --admin --json
```

That resolves `MEMHOUSE_ADMIN_USER` / `MEMHOUSE_ADMIN_PASSWORD` when they are set and
falls back to the configured credential, then reports what it may actually do. Read
`role` and the capability flags; never infer privileges from a grant string yourself.
The command prints no password.

- **`"canProvision": true`** (or `"role": "administrator"`) — you have an administrator.
  Go to §2.
- **`"canProvision": false`** — the credential is a member. **Stop.** Do not retry, do
  not look for a stored password, and do not ask for one. Tell the user:

  > `/mem:admin` needs an administrator credential for `<url>`, and what is configured
  > here is the member account `<user>` — it owns its own house and nothing else. If you
  > administer that ClickHouse, put the credential in this shell's environment and ask
  > again:
  >
  > ```
  > export MEMHOUSE_ADMIN_USER=default
  > read -rs MEMHOUSE_ADMIN_PASSWORD && export MEMHOUSE_ADMIN_PASSWORD
  > ```
  >
  > `read -rs` keeps it off the screen and out of your shell history. It lives only in
  > that shell — nothing is written to disk, and memhouse never stores it.
  >
  > If somebody else administers the server, this is theirs to run, not yours.

- **`"ok": false`** — a connection problem, not a privilege one. Report `reason` as
  given; do not translate it into "you are not an admin".

**Never suggest storing the credential** — not in `~/.memhouse/env`, not in an
`admin.env`, not anywhere on disk. An admin credential owns the whole server, and every
process running as this user can read a file. The environment of one shell is the whole
supported surface. (A house from `memhouse deploy --local` is the exception that needs
nothing: its member *is* the superuser, and `whoami` will already say so.)

## 2. Do the work

Use the same environment for every query. `--fail-with-body` so ClickHouse's own error is
visible; `&readonly=1` on anything that only reads.

```bash
adm() { curl -sS --fail-with-body \
  --user "$MEMHOUSE_ADMIN_USER:$MEMHOUSE_ADMIN_PASSWORD" \
  --data-binary "$1" "$MEMHOUSE_URL/${2-}"; }
adm "SELECT …  FORMAT PrettyCompact" "?readonly=1"
```

Reads worth knowing — reach for these before inventing SQL:

| Question | Query |
|---|---|
| who exists | `SELECT name, storage FROM system.users ORDER BY name` |
| what someone may do | `SHOW GRANTS FOR <user>` |
| every house and its size | `SELECT database, formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows FROM system.parts WHERE active GROUP BY database ORDER BY sum(bytes_on_disk) DESC` |
| a house's rooms | `SELECT table, formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows FROM system.parts WHERE active AND database = '<db>' GROUP BY table` |
| who writes where | `SELECT user_id, host, count() FROM <db>.messages GROUP BY user_id, host` |
| running queries | `SELECT query_id, user, elapsed, formatReadableSize(memory_usage) AS mem, substring(query,1,120) AS q FROM system.processes` |
| unfinished mutations | `SELECT database, table, mutation_id, command, parts_to_do, latest_fail_reason FROM system.mutations WHERE NOT is_done` |

### Sharing on someone else's behalf

A member runs `memhouse share` against their own house. An administrator can do it for
any house — useful when someone asks you to open theirs, or to audit what is open:

```bash
# what every house has opened up, server-wide
adm "SELECT database, short_name, table, select_filter FROM system.row_policies ORDER BY database, short_name FORMAT PrettyCompact" "?readonly=1"
adm "SHOW GRANTS FOR <user>"
```

To change a share, prefer running the member's own command with their credential over
hand-writing SQL — the CLI handles the four traps (a permissive catch-all failing open,
the server setting that decides whether unpolicied readers see anything, revoke leaving
policies behind, and the three rooms drifting out of step). When you must do it as
admin, mirror exactly what the CLI does: a policy on **all three rooms** or none, and
`DROP ROW POLICY` on every room when withdrawing.

**Dropping a house does not drop its row policies.** They persist as orphans, and a house
later recreated under the same name silently inherits them. After any `DROP DATABASE`:

```bash
adm "SELECT short_name, table FROM system.row_policies WHERE database = '<db>'"
# then DROP ROW POLICY <name> ON <db>.<table> for each
```

**Prefer a CLI verb over raw SQL wherever one exists.** `memhouse invite <name> --url …`
provisions a member correctly — right grants, right pin, refuses a house that already
holds someone's messages — and it takes `--admin-user`/`--admin-password`, so it works
from this environment. Hand-written `CREATE USER` skips every one of those guards. This
skill is for what no verb covers.

## 3. Destructive work — look first, then confirm

`DROP DATABASE`, `DROP USER`, `REVOKE`, `ALTER … DELETE`, `TRUNCATE`, `KILL QUERY` and
password rotation all change something a person depends on. There are no backups and no
undo: a dropped house is gone, and the transcripts behind it may have aged out of the
editors that produced them.

Before any of them:

1. **Look at the target and report what is really there** — row counts per room, who
   wrote them, the date span, which machines. A house you expected to be empty may not
   be: one `ege` house looked disposable and held 3,733 messages belonging to somebody
   else entirely.
2. **Name the collateral.** Dropping a user stops that account's shipper on every machine
   it runs on. Revoking a grant closes a share someone may be mid-query on. Rotating a
   password breaks every machine shipping under it — and grants are per-user while the
   fleet is per-`user@host`, so there is no way to revoke one machine.
3. **Get an explicit yes for that specific object**, quoting the counts you just read. A
   general "yes, do admin things" is not consent to drop a populated house.
4. **Verify afterwards** and say what is now true, including what was destroyed.

If the user has already told you exactly what to destroy and why, and the counts match
their description, proceed — do not re-litigate a decision they have made.

## Never

Never accept an admin password typed into the conversation, and never print one — not in
a command, not in an echo, not in an error. Commands expand `"$MEMHOUSE_ADMIN_PASSWORD"`;
the value never appears as literal text.

Never recommend writing an admin credential to disk.

Never widen a member's grants beyond what `memhouse invite` issues unless the user asks
for that specific privilege and has been told what it allows. Never grant `ACCESS
MANAGEMENT`, `CREATE USER`, or anything at `*.*` casually — those mint a second
administrator.

Never touch a house that is not the subject of the request, and never run a destructive
statement whose predicate you have not first run as a `SELECT`.
