---
name: share
description: Share your conversation memory with another user on the same ClickHouse — grant them read-only access to your house, list who can currently read it, or revoke a share. Use when the user says "share my memory with X", "let X see my sessions", "who can read my memory", "stop sharing with X". Read-only by construction — a share can never let anyone write to or delete your memory.
user-invocable: true
argument-hint: "[<user> | revoke <user> | (nothing: list current shares)]"
allowed-tools: Bash
---

# /mem:share — a read-only window into your memory

Three forms, decided by the arguments:

- `/mem:share yigit` — let `yigit` read this house
- `/mem:share revoke yigit` — close that window
- `/mem:share` — who can read this house right now

Sharing is a ClickHouse GRANT and nothing else — memhouse adds no layer on top, so what
you grant is exactly what they get: `SELECT`, never write, never delete. Your own grant
carries `WITH GRANT OPTION` on SELECT only (installs from 0.10.0 on), so you can open
this window yourself and can hand on nothing more.

## Connection

**Never print this file or the variables in it.** No `cat "$MH_ENV"`, no `env | grep
MEMHOUSE`, no `set -x` around these commands.

```bash
MH_ENV="${MEMHOUSE_HOME:-$HOME/.memhouse}/env"
_u=${MEMHOUSE_URL-}; _s=${MEMHOUSE_USER-}; _p=${MEMHOUSE_PASSWORD-}; _d=${MEMHOUSE_DB-}
set -a; [ -f "$MH_ENV" ] && . "$MH_ENV"; set +a
[ -n "$_u" ] && MEMHOUSE_URL=$_u; [ -n "$_s" ] && MEMHOUSE_USER=$_s
[ -n "$_p" ] && MEMHOUSE_PASSWORD=$_p; [ -n "$_d" ] && MEMHOUSE_DB=$_d
if [ -z "${MEMHOUSE_URL:-}" ] || [ -z "${MEMHOUSE_USER:-}" ]; then
  echo "no memhouse house configured — nothing in $MH_ENV and no MEMHOUSE_URL/MEMHOUSE_USER set." >&2
  echo "Run: memhouse install" >&2
  exit 1
fi

# NO readonly=1 on this skill's grant/revoke calls — GRANT is refused under readonly.
# The list query below still pins it.
curl -sS --fail-with-body --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-mem}" <<'SQL'
<the statement>
SQL
```

## Grant — `/mem:share <user>`

The user name goes into SQL unquoted: **refuse anything not matching
`[A-Za-z][A-Za-z0-9_]*`** rather than quoting it — a name you cannot type bare is a name
that will be gotten wrong everywhere else too.

**Validate `<user>` FIRST, once, and use only the validated token — in the GRANT, the
REVOKE, and the house_meta record alike.** The record INSERT is a quoted literal;
anything that has not passed the name check must never reach it.

**`<db>` below is the LIVE value of `$MEMHOUSE_DB` — print it with the connection
(`echo "house: $MEMHOUSE_DB"`) and use THAT in every statement and every piece of
advice.** Driven live, a model filled `<db>` in the admin advice with the literal
fallback `mem` while the real house was named differently — advice the admin would have
run against the wrong database.

```sql
GRANT SELECT ON <db>.* TO <user>
```

(`<db>` is `$MEMHOUSE_DB`.) Then RECORD it in the house's own memory — a member cannot
read `system.grants` (measured: `Not enough privileges … SELECT ON system.grants`), so
this record is what the list form reads back:

```sql
INSERT INTO house_meta (key, value) VALUES ('share:<user>', 'granted <today, YYYY-MM-DD>')
```

Verify the grant took by USING it if you can, or simply report the server accepted it —
do not call `SHOW GRANTS FOR <user>` (it needs privileges a member does not hold).

Two failure shapes, both to report exactly:

- `There is no user ... in user directories` — the person has no ClickHouse user on this
  server yet. Joining comes first: they run `memhouse install` against this server (or
  the admin runs `memhouse install --print-sql --member <user> --db <their-house>`).
  A share cannot create a user, by design.
- `Not enough privileges` — either this house predates 0.10.0 (your own grant carries
  no grant option), or **the configured house is not yours to share** (a team house, or
  someone else's). Only suggest the admin remedy when the house is the user's OWN — the
  grant-option statement hands them standing power to share it, which is the owner's
  decision, not a fix. For their own pre-0.10 house, print for the ADMIN:
  `GRANT SELECT ON <db>.* TO <user>` — and to make future shares self-serve:
  `GRANT SELECT ON <db>.* TO <your-user> WITH GRANT OPTION`.
  For a house that is not theirs, say so and stop: the owner shares it, not you.

Tell the user how their friend actually reads it: qualified names —
`SELECT … FROM <db>.messages …` — from /mem:ask, /mem:search or /mem:sql on the friend's
side, with the same epoch filter those skills already carry.

## Revoke — `/mem:share revoke <user>`

```sql
REVOKE SELECT ON <db>.* FROM <user>
```
```sql
INSERT INTO house_meta (key, value) VALUES ('share:<user>', 'revoked <today, YYYY-MM-DD>')
```

Revoking a share that never existed is a no-op, not an error — say which it was (the
`share:<user>` record answers that).

## List — `/mem:share` (no arguments)

From the house's own record (append `&readonly=1` to the URL for this one):

```sql
SELECT substring(key, 7) AS user, value AS state,
       formatDateTime(updated_at, '%Y-%m-%d %H:%i') AS at
FROM house_meta FINAL WHERE key LIKE 'share:%' ORDER BY key
```

Latest-wins per user: `granted …` rows are live shares, `revoked …` rows are closed
ones. Be honest about the record's edge: it shows shares made THROUGH THIS SKILL — a
grant the admin issued directly will not appear. The authoritative list is the admin's
one query: `SELECT user_name, access_type FROM system.grants WHERE database = '<db>'`
(members cannot run it; `system.grants` needs privileges a member does not hold).

## What this never does

No `GRANT ALL`, no write grants, no `WITH GRANT OPTION` onward, no user creation, no
grants on any database but your own. If the user asks for more than read access, that is
the shared-house model (both members in ONE database) — a decision, not a grant; point
them at `memhouse install --db <shared>` and stop.
