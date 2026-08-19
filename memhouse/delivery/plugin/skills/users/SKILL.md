---
name: users
description: Show the people around your memory — who writes into your house and from which machines, which other houses on this ClickHouse you can read, and who can read yours. Use when the user asks "who can see my memory", "whose memory can I see", "which houses are on this server", "who else ships here", or before/after sharing with /mem:share.
user-invocable: true
argument-hint: ""
allowed-tools: Bash
---

# /mem:users — who is around your memory

**Invoking this skill IS the request. Run the report immediately and present it; there
are no arguments and nothing to clarify.** Read-only throughout.

Throughout, `<your-db>` is the live `$MEMHOUSE_DB` and `<your-user>` the live
`$MEMHOUSE_USER` — take both from the connection environment, never from the
conversation or from examples.

Answers three questions, best-effort by design: ClickHouse shows a credential only what
it may see, so on someone else's server some sections legitimately come back thin — say
what could not be seen rather than guessing.

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

curl -sS --fail-with-body --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
  --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-mem}&readonly=1" <<'SQL'
<the query>
FORMAT PrettyCompact
SQL
```

## The report

**1. Who writes into YOUR house** — members × machines, from the data (same ground truth
as /mem:status's fleet):

```sql
SELECT user_id AS member, host AS machine, count() AS rows,
       formatDateTime(max(ingested_at), '%Y-%m-%d %H:%i') AS last_write
FROM messages GROUP BY user_id, host ORDER BY last_write DESC
```

**2. Whose memory YOU can read** — every database your credential reaches is one someone
gave you (or your own):

```sql
SHOW DATABASES
```

Drop `system`, `information_schema`, `INFORMATION_SCHEMA`, `default` unless they hold
rooms. For each OTHER house listed, it is readable because of a grant — one line each:
`house 'polat' — readable (shared with you); query it as polat.messages`.

**3. Who can read YOURS** — from the house's own share record (`system.grants` needs
privileges a member does not hold, so the record /mem:share keeps is the readable
source; an admin-issued grant will not appear in it, and the report should say so):

```sql
SELECT substring(key, 7) AS user, value AS state
FROM house_meta FINAL WHERE key LIKE 'share:%' ORDER BY key
```

`granted …` = a live read window (`/mem:share`); `revoked …` = closed. If the caller IS
privileged, prefer the authoritative form:
`SELECT user_name, groupUniqArray(access_type) FROM system.grants WHERE database = '<your-db>' AND user_name != '<your-user>' GROUP BY user_name`
— try it first, fall back to the record on refusal.

**4. Every user on the server** — usually admin-only; try it, and if refused say
"(full user list needs admin — showing only what this credential can see)":

```sql
SELECT name FROM system.users ORDER BY name
```

## Presenting it

Four short sections in that order, each with its one-line meaning ("2 machines ship into
your house", "you can read polat's memory", "yigit can read yours — read-only", …).
Empty section three means "no shares made through /mem:share" — and ONLY that. The
record cannot see an admin-issued grant, so never promise "nobody can read your memory"
from an empty ledger; say "no shares recorded through this skill — the authoritative
check is the admin's system.grants query" and print it. Point at `/mem:share <user>` /
`/mem:share revoke <user>` for changes.
