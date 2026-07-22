# mem-house — install as a kernel agency

How to run mem-house as an **agency** on an ultimagent kernel (a promoted
ClickHouse realm), instead of a plain ClickHouse. Same flow proven for the
agentlytics agency (`agency/AGENCY.md`); the agency/house name here is
**`memhouse`** (CH identifiers can't carry a dash).

## 1. Provision (operator, one-time — from the kernel checkout)

```bash
python3 executor/executor.py provision memhouse
```

Submits `install-agency{name:'memhouse'}`; the mayor approves; the executor (as
`kernel`) creates database `memhouse` (the house), owner `memhouse_root`
(`realm_user` profile), and owner grants. It returns a one-time **credential** —
rotate on first connect (`issue-credential{user:'memhouse_root'}`).

## 2. Owner sets up the house (from this repo)

```bash
export MEMHOUSE_URL=https://<kernel-host>:8443
export MEMHOUSE_USER=memhouse_root
export MEMHOUSE_PASSWORD=<credential-from-provision>
export MEMHOUSE_DB=memhouse
node mem-house/shipper/ship.js --ensure-schema
node mem-house/shipper/ship.js          # first ship; then --loop 300 to keep fresh
```

The kernel never runs or reads any of this — it is content-blind; the shipper is
the agency's own deterministic worker (no LLM, not an injection surface).

## 3. Members (multi-user)

For each person joining, split across the two authorities:

```bash
# KERNEL mints the identity (mayor-approved):
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
  **kernel or mayor** applies `mem-house/rls.sql` (three row policies bound to the
  `member` role). The owner cannot — `CREATE ROW POLICY` needs ACCESS MANAGEMENT,
  which the kernel withholds from agency owners by design.
- **Team pool** (everyone sees everything): apply no policy; the owner GRANTs from
  step 3 are the whole model.

Pick one; do not mix on the same role.

## 5. Verify

```bash
node mem-house/shipper/ship.js --stats      # per-source counts as the owner
# as a member (own-only): counts reflect only that member's rows
curl -s -u "alice:<pw>" "$MEMHOUSE_URL/?database=memhouse" \
  --data-binary "SELECT count() FROM sessions_v SETTINGS final=1"
```
