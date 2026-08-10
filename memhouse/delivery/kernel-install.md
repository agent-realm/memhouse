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
Design and measurements: `../per-member/`.

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
npm install -g memhouse --allow-scripts=better-sqlite3
memhouse install --yes \
  --url https://<kernel-host>:8443 \
  --user memhouse_root \
  --password <credential-from-provision> \
  --db mem
```

That writes `~/.memhouse/env`, applies the schema, and runs the first ship.
`memhouse start` then keeps it fresh on a 300s loop.

Keep `--allow-scripts=better-sqlite3`: without it npm 12 leaves `better-sqlite3`
with no native binding and the five SQLite-backed adapters ship nothing, silently.
`memhouse discover` names any adapter it had to skip.

The kernel never runs or reads any of this — it is content-blind; the shipper is
the agency's own resident, a deterministic `worker` on a loop (no LLM, not an
injection surface). It is the only thing here that writes without being asked.

## 3. Members (multi-user)

For each person joining, split across the two authorities:

```bash
# The realm's privileged user mints the identity; the human owner approves:
python3 executor/executor.py submit register-member '{"handle":"alice"}'
python3 executor/executor.py approve <call_id> && python3 executor/executor.py drain

# OWNER mints that member's three rooms and their grants (memhouse_root has
# grant-option on mem.*). One idempotent step — see ../per-member/PROVISIONING.md:
MEM_URL=https://<kernel-host>:8443 MEM_USER=memhouse_root \
MEM_PASSWORD=<credential> MEM_DB=mem \
  node memhouse/per-member/provision.js --member alice --merge
```

**Never `GRANT … ON mem.*` to a member.** A member who can read `mem.*` can read every
other member's rooms, and then this is a shared house with longer table names.
`provision.js` grants per room: `ALL` on each of alice's three, plus a re-grantable
`SELECT` on each (that split is what makes a share read-only by construction), plus
`SELECT` on the `Merge` rooms.

Each member then runs the shipper with **their own** credential
(`MEMHOUSE_USER=alice`) — it writes to `sessions_alice` / `messages_alice` /
`tool_calls_alice`, resolved from `SELECT currentUser()` rather than from config, and
the house stamps `user_id='alice'` on their rows, un-spoofably
(`MATERIALIZED currentUser()`, `async_insert=0`).

## 4. Visibility

**Own-only is the default and needs no policy.** Alice is granted her own three rooms
and nobody else's, so bob's rooms are not hidden from her — they are simply not hers to
read, and the failure mode of a missing grant is a denial rather than a leak.

**Team-wide reads are the `Merge` rooms** (`all_sessions`, `all_messages`,
`all_tool_calls`) plus a `GRANT SELECT` on them, which `provision.js --merge` issues. A
`Merge` room narrows to whatever underlying rooms the caller already holds grants for —
measured on 26.7.1: no leak, no error — so it can be granted broadly. It also
auto-discovers rooms created after it, so onboarding a member needs no DDL there.

A member widens what a colleague sees by granting their own rooms directly
(`GRANT SELECT ON mem.messages_alice TO bob`) — self-serve, no operator, because the
member holds grant-option on their own `SELECT`. See `../per-member/SHARING.md`.

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
