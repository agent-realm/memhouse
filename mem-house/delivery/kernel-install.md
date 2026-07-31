# mem-house — install as a kernel agency

How to run mem-house as an **agency** on an ultimagent kernel — a ClickHouse server
(a **town**) promoted into a realm — instead of a plain ClickHouse. Same flow proven
for the agentlytics agency (`agency/AGENCY.md`); the agency/house name here is
**`memhouse`** (CH identifiers can't carry a dash). What lands is a **house** (the
`memhouse` database) with a **resident** (the shipper — `kind = "worker"`,
`on = "loop"`) — that pairing is the agency. Residents write; routines read, and the
`sessions_v` view is a routine. Terms: `../../TERMINOLOGY.md`.

This is an operator runbook, so it speaks machine vocabulary throughout — ClickHouse,
`GRANT`, row policies. That is correct for this audience.

## 1. Provision (operator, one-time — from the kernel checkout)

```bash
python3 executor/executor.py provision memhouse
```

Submits `install-agency{name:'memhouse'}`; the mayor — the human owner — approves;
the executor (running as the ego, the `kernel` user) creates database `memhouse`
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
  --db memhouse
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
# The EGO (the `kernel` user) mints the identity; the mayor approves:
python3 executor/executor.py submit register-member '{"handle":"alice"}'
python3 executor/executor.py approve <call_id> && python3 executor/executor.py drain

# OWNER grants house access (memhouse_root has grant-option on memhouse.*):
#   GRANT INSERT, SELECT ON memhouse.* TO alice
```

Each member then runs the shipper with **their own** credential
(`MEMHOUSE_USER=alice`) — the house stamps `user_id='alice'` on their rows,
un-spoofably (`MATERIALIZED currentUser()`, `async_insert=0`).

## 4. Visibility: own-only vs team pool

- **Own-only** (memory-house's model — each member sees only their own rows): the
  **ego (the `kernel` user) or the mayor** applies `mem-house/rls.sql` (three row
  policies bound to the `member` role). The owner cannot — `CREATE ROW POLICY` needs
  ACCESS MANAGEMENT, which the kernel withholds from agency owners by design.
- **Team pool** (everyone sees everything): apply no policy; the owner GRANTs from
  step 3 are the whole model.

Pick one; do not mix on the same role.

## 5. Verify

```bash
memhouse stats                              # per-source counts as the owner
# as a member (own-only): counts reflect only that member's rows
curl -s -u "alice:<pw>" "$MEMHOUSE_URL/?database=memhouse" \
  --data-binary "SELECT count() FROM sessions_v SETTINGS final=1"
```
