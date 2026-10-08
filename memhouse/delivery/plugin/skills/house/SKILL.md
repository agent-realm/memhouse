---
name: house
description: The state of your memory and who is around it — what memhouse is and how to use it, whether shipping is working, what the house holds (sessions, messages, tokens per editor), how fresh it is, which machines write into it, which houses you can read, and who can read yours. Use for "what is memhouse", "how do I use this", "is my memory working", "how much is stored", "when did it last ship", "which machines are shipping", "who can see my memory", "whose memory can I see", "who else is on this server" — and as the first answer when another /mem skill fails because nothing is configured yet, or before debugging why a search found nothing.
user-invocable: true
argument-hint: ""
allowed-tools: Bash
---

# /mem:house — what this is, whether it works, and who is around it

**Invoking this IS the request. Run the report and present it; there is nothing to
clarify.** Read-only throughout.

**Read `../../reference/HOUSE.md` first** — connection, schema, and the epoch filter every
count below depends on.

## Nothing configured yet? Answer that instead

If the connection block finds no house, do not report an error — explain the product and
stop:

> **memhouse** gives your coding agents a memory. A local shipper parses your sessions
> from 17 editors — Claude Code, Codex, Cursor, Zed, Gemini CLI and more — and writes
> them as typed rows into a ClickHouse database **you own**. Nothing is embedded or
> summarised; the transcripts are kept verbatim, and the house outlives the local files,
> which most editors delete after about 30 days.
>
> Then any agent can read it: `/mem:recall` answers from your own history instead of
> starting from zero.
>
> To set it up: `npm install -g memhouse` then `memhouse onboard`. No ClickHouse yet?
> `memhouse deploy --local` stands one up bound to loopback. Someone invited you?
> `memhouse install --env invite-<you>.env`.

## First: which memhouse this is

Before anything else, run and show verbatim:

```
"${MEMHOUSE_BIN:-memhouse}" instance
```

One screen: the instance's name and home, the binary and channel, the house (server,
database, member, whether an admin credential is present), the five rooms with row counts,
what this machine ships, the host identity, the daemons, and which playbooks are bound to
this instance. A machine can run several instances on different channels; this is how the
user tells them apart, and how you know which house every answer below comes from. If the
instance shown is not the one the user meant, stop and say so — the fix is launching
under the right playbook, not overriding variables.

## The report

Lead with the one-line verdict — *working and current*, *working but stale*, or *not
shipping* — then the detail.

**1. Identity and reach.** `memhouse whoami` — who this credential is and what it may do.
`memhouse status --json` — daemons, connection, counts, freshness. Prefer these over
hand-rolled queries; they already know the schema.

**2. What the house holds**, per editor. Epoch filter required or every number is inflated:

```sql
SELECT source,
       uniqExact(session_id) AS sessions,
       count() AS messages,
       sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
       formatDateTime(max(ts), '%Y-%m-%d %H:%i') AS newest
FROM messages
WHERE origin != 'ship'
   OR (session_id, user_id, epoch) IN (
        SELECT session_id, user_id, max(epoch) FROM messages
        WHERE origin = 'ship' GROUP BY session_id, user_id)
GROUP BY source ORDER BY messages DESC
```

**A source shipping zero tokens is not free — it is unmeasured.** `kiro`, `vscode`, `zed`
and one of `cursor`'s two storage paths extract no usage, so their cost reads `$0`. Say
"unknown", never "$0", and point at `memhouse doctor`.

**3. Which machines write here**, and whether this one is among them:

```sql
SELECT user_id AS member, host AS machine, count() AS rows,
       formatDateTime(max(ingested_at), '%Y-%m-%d %H:%i') AS last_write
FROM messages GROUP BY user_id, host ORDER BY last_write DESC
```

A machine silent for days is the usual reason a search finds nothing. Note that the
*fleet heartbeat* records that a pass CONNECTED, not that rows landed — so treat
`last_write` from the data above as the truth, and be sceptical of a healthy-looking
heartbeat beside a stale `last_write`.

**4. Who can read your house, and whose you can read.** Best-effort by design — ClickHouse
shows a credential only what it may see, so on someone else's server sections come back
thin. Say what could not be seen rather than guessing.

```sql
-- houses your credential can reach; anything that is not yours was shared with you
SHOW DATABASES
-- who you have granted (memhouse's own record of it)
SELECT substring(key, 7) AS user, value AS state
FROM meta FINAL WHERE key LIKE 'share:%' ORDER BY key
-- everyone on the server (names only — every member holds SHOW USERS)
SELECT name FROM system.users ORDER BY name
```

That `meta` list is memhouse's own note-keeping, not ClickHouse's grant table —
a member cannot read `system.grants`. Present it as "what memhouse recorded", and say
that a grant made by hand would not appear.

## Closing

End with the one useful next step, not a menu: reopen a session (`memhouse resume <id>`),
fix a stale machine (`memhouse update` there), start shipping (`memhouse onboard`), or
bring someone in (`/mem:access`). If everything is healthy, say so in one line and stop.
