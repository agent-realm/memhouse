# memhouse — install as a kernel agency

How to run memhouse as an **agency** on an ultimagent kernel — a ClickHouse server
(a **town**) promoted into a realm — instead of a plain ClickHouse. Same flow proven
for the agentlytics agency (`agency/AGENCY.md`); the agency is named **`memhouse`** and
its house is the **`mem`** database (CH identifiers can't carry a dash, and the owning
role kept the longer name — `memhouse_root`). What lands is a **house** (the `mem`
database) with a **resident** (the shipper — `kind = "worker"`, `on = "loop"`) — that
pairing is the agency. Residents write; routines read, and the session rollup is a
routine. Terms: `../../TERMINOLOGY.md`.

**One set of rooms per member.** Each member owns `sessions_<them>`, `messages_<them>`,
`tool_calls_<them>` and holds grants on those and nothing else, so isolation is an
absent grant rather than a row policy — it fails closed. There is no shared
`sessions`/`messages`/`tool_calls` layout and no row policy in the default path; 0.4.0
removed both. Team-wide reads are the `Merge` rooms plus a `GRANT`. The session rollup
is a **saved query**, not a stored view — `memhouse sessions-query` prints it.
Design and measurements: `../house/HOUSE.md`.

This is an operator runbook, so it speaks machine vocabulary throughout — ClickHouse,
`GRANT`, `currentUser()`. That is correct for this audience.

## 1. Provision (operator, one-time — from the kernel checkout)

```bash
python3 executor/executor.py provision memhouse
```

Submits `install-agency{name:'memhouse'}`; the human owner approves; the executor
(running as the realm's privileged user) creates database `mem`
(the house), owner `memhouse_root`
(`realm_user` profile), and owner grants. It returns a one-time **credential** —
rotate on first connect (`issue-credential{user:'memhouse_root'}`).

## 2. Owner sets up the house

```bash
npm install -g memhouse
memhouse install --yes \
  --url https://<kernel-host>:8443 \
  --user memhouse_root \
  --password <credential-from-provision> \
  --db mem
```

That writes `~/.memhouse/env`, applies the schema, and runs the first ship.
`memhouse start` then keeps it fresh on a 300s loop.

No flags: SQLite comes from `node:sqlite`, so there is no native binding to build
and no adapter that can go dark for want of one. `memhouse discover` still names any
adapter it had to skip — now always a single editor's own store.

The kernel never runs or reads any of this — it is content-blind; the shipper is
the agency's own resident, a deterministic `worker` on a loop (no LLM, not an
injection surface). It is the only thing here that writes without being asked.

## 3. Members (multi-user)

For each person joining, split across the two authorities:

```bash
# The realm's privileged user mints the identity; the human owner approves:
python3 executor/executor.py submit register-member '{"handle":"alice"}'
python3 executor/executor.py approve <call_id> && python3 executor/executor.py drain

# OWNER admits the member to the house — two statements, any DBA knows them:
#   CREATE USER alice IDENTIFIED BY '…';
#   GRANT ALL ON mem.* TO alice;
# (memhouse can run them: memhouse install --admin-user … --member alice)
```

Each member then runs the shipper with **their own** credential
(`MEMHOUSE_USER=alice`) — everyone writes into the SAME three tables (`sessions`,
`messages`, `tool_calls`), and the house stamps `user_id='alice'` on her rows,
un-spoofably (`MATERIALIZED currentUser()`, with `async_insert = 0 CONST` pinned on the
user so the stamp cannot be skipped). Her machines are told apart by `host`.

## 4. Visibility

**A house is shared by its housemates.** The tables are common; `user_id` and `host` say
who wrote what, and `WHERE user_id = 'alice'` is one person. The boundary is the
DATABASE: a member of `mem` holds nothing on any other database, so two agencies on one
kernel ClickHouse cannot read each other. WITHIN a house, members hold their own rooms
and nothing else — housemates are isolated from each other by grant, not by trust, and
each can verify it with `SHOW GRANTS`. A separate house remains the boundary between
groups that should not know of each other at all.

Row policies are still the only way to share a *subset* of rows, which is owner-mediated
and documented in `SHARING.md` — they are not how isolation works.

## 5. Verify

```bash
memhouse stats                              # per-source counts as the owner
# as a member: the rollup resolves to alice's own rooms, so counts are hers alone
curl -s -u "alice:<pw>" "$MEMHOUSE_URL/?database=mem" \
  --data-binary "SELECT count() FROM $(memhouse sessions-query) AS c SETTINGS final=1, join_use_nulls=1"
# and the team room narrows rather than denying — alice sees herself plus whoever granted her
curl -s -u "alice:<pw>" "$MEMHOUSE_URL/?database=mem" \
  --data-binary "SELECT user_id, count() FROM all_messages GROUP BY user_id SETTINGS final=1"
```
