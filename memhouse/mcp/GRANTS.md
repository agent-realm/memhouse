# The grant model — tested, not asserted

2026-08-16. Run against a throwaway `clickhouse/clickhouse-server:latest`
(**26.7.1.1315**) on `127.0.0.1:18777`/`18778`, both removed with `docker rm -f -v`
afterwards. No real house was touched.

Question behind it (pilot, 2026-08-16): authorization is the pilot's job via GRANTs,
not the application's via a SQL parser — and can a house credential mint further,
narrower credentials for agents ("shadow users")?

**Answer: yes, and ClickHouse enforces the containment itself.**

## What was run and what came back

| # | As | Statement | Result |
|---|---|---|---|
| 1 | `house` (`GRANT ALL ON mem.* WITH GRANT OPTION`) | `CREATE USER reader` | **DENIED** — `497 … necessary to have the grant CREATE USER ON reader` |
| 2 | `default` | `GRANT CREATE USER, DROP USER ON *.* TO house WITH GRANT OPTION` | OK |
| 3 | `house` | `CREATE USER reader IDENTIFIED BY …` | OK |
| 4 | `house` | `GRANT SELECT ON mem.* TO reader` | OK |
| 5 | `house` | `GRANT URL ON *.* TO reader` | **DENIED** — `497 … necessary to have the grant READ, WRITE ON URL WITH GRANT OPTION` |
| 6 | `house` | `GRANT SELECT ON other.* TO reader` | **DENIED** — `497 … SELECT ON other.* WITH GRANT OPTION` |
| 7 | `reader` | `INSERT` / `DROP TABLE` / `TRUNCATE` / `ALTER … DELETE` | **DENIED**, all four, `497` |
| 8 | `reader` | `SELECT * FROM url('http://example.com/',…)` | **DENIED** — `497 … the grant READ ON URL` |
| 9 | `reader` | `SELECT * FROM file('/etc/hostname',…)` | **DENIED** — `291 … not inside /var/lib/clickhouse/user_files` |
| 10 | `reader` | `SELECT count() FROM other.x` | **DENIED** — `60 UNKNOWN_TABLE` (does not even resolve) |
| 11 | `reader` | `SELECT count() FROM system.users` | **DENIED** — `497` |
| 12 | `reader` | `CREATE USER evil` | **DENIED** — `497` |
| 13 | `reader` | `GRANT INSERT ON mem.* TO reader` (self-escalation) | **DENIED** — `497 … INSERT ON mem.* WITH GRANT OPTION` |
| 14 | `reader` (after being given SELECT **WITH GRANT OPTION** + `CREATE USER`) | `GRANT SELECT ON mem.* TO sub` | OK |
| 15 | same | `GRANT INSERT ON mem.* TO sub` | **DENIED** — holds INSERT, but not with grant option |

### Pinned readonly, for a credential that *does* hold write grants

| # | As | Statement | Result |
|---|---|---|---|
| 16 | `default` | `CREATE USER robo … SETTINGS readonly = 1 CONST` + `GRANT ALL ON mem.*` | OK |
| 17 | `robo` | `SELECT` | OK |
| 18 | `robo` | `INSERT` / `DROP TABLE` | **DENIED** — `164 … Cannot execute query in readonly mode` |
| 19 | `robo` | `POST /?readonly=0` | **DENIED** — `164 … Cannot modify 'readonly' setting in readonly mode` |
| 20 | `robo` | `SET readonly=0` | **DENIED** — `164`, same |

### Access management can be name-scoped

| # | As | Statement | Result |
|---|---|---|---|
| 21 | `default` | `GRANT CREATE USER ON mem_* TO house` | OK |
| 22 | `house` | `CREATE USER mem_agent1` | OK |
| 23 | `house` | `CREATE USER randomguy` | **DENIED** — `497 … CREATE USER ON randomguy` |
| 24 | `house` | `GRANT SELECT ON mem.* TO mem_agent1` | OK |
| 25 | `house` | `DROP USER default` | **DENIED** — `497 … DROP USER ON default` |

## What this establishes

1. **`GRANT ALL ON <db>.*` is not "all".** It confers nothing global: no `URL`, no
   `FILE`, no `REMOTE`/`S3`, no access management, no other database. The standard
   memhouse member (`bin/memhouse.js:642`) therefore **already** cannot dial out. The
   application-side table-function parser re-derives a refusal the server issues on
   its own — with a better error message than ours.
2. **A user can only grant what it holds WITH GRANT OPTION** (#5, #6, #13, #15).
   Delegation cannot widen. This is the containment property the shadow-user idea
   needs, and it is enforced by the server, not by convention.
3. **Minting is opt-in and boundable.** Access management is not part of the house
   grant (#1); the pilot adds it deliberately, and can scope it to a name prefix
   (#21–#25) so the house admin mints `mem_*` users and cannot touch `default` or any
   user outside the prefix.
4. **`readonly = 1 CONST` is a real belt** for an agent credential that still holds
   write grants: the client cannot unpin it, not by `SET` and not by query parameter
   (#19, #20). Useful when the same credential must ship *and* be exposed to an agent.
   Note it is coarser than a grant — it blocks every write, including the shipper's.
5. **`file()` has a second, independent fence** — `user_files` path confinement
   (#9) — which applies even where the grant does not.
6. The official image's `default` user has **no access management** unless
   `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1` is set (found the hard way in setup).

## The recipe this implies

Three roles, and the pilot chooses how far to go:

```sql
-- 1. the house owner (what memhouse installs today)
CREATE USER alice IDENTIFIED BY '…';
GRANT ALL ON mem.* TO alice WITH GRANT OPTION;

-- 2. a read-only credential for agent-facing surfaces (MCP, dashboard, skills)
CREATE USER mem_reader IDENTIFIED BY '…';
GRANT SELECT ON mem.* TO mem_reader;

-- 3. optional: let the owner mint further narrow users, bounded by prefix
GRANT CREATE USER, DROP USER ON mem_* TO alice;
```

Then point the shipper at `alice` and the MCP server at `mem_reader`. An agent that
runs `DROP TABLE mem.messages` — by accident, by a bad plan, or because a poisoned
transcript told it to — gets `497 Not enough privileges` from the server, and no
application code had to be right for that to happen.

## Consequences for the build plan

- P2 (extract the SQL parser) is **cut**. See the plan.
- P3 gains: MCP resolves a credential like everything else, and the docs teach the
  reader role. The tool description for `sql` says the query runs under the caller's
  configured credential and that its limits are the pilot's grants.
- `memhouse doctor` should print `SHOW GRANTS` for the configured credential, so the
  pilot can see what they handed over instead of assuming.
- Provisioning (`memhouse onboard` / `install`) should offer to create the reader user
  alongside the owner. One extra statement at install time is worth more than any
  amount of parser.

---

## Addendum, 2026-08-22 — finding #1 no longer holds: a member CAN dial out

Re-probed against the grant set `bin/memhouse.js` writes **today** (master 0.12.7 +
the unreleased relocate fix), on a throwaway 25.11:

```sql
GRANT ALL ON <db>.* TO <member> WITH GRANT OPTION;   -- 0.12.7 (was ALL + SELECT WITH GRANT OPTION)
GRANT ALTER USER ON <member> TO <member>;
GRANT SHOW USERS ON *.* TO <member>;                 -- 0.12.6, new, GLOBAL
GRANT REMOTE  ON *.* TO <member>;                    -- unreleased, new, GLOBAL
```

Every probe below ran as the member with `readonly=2` pinned — exactly what the MCP
`sql` tool sends:

| Probe | Result |
|---|---|
| `SELECT 1` | ALLOWED |
| `CREATE TABLE` (any write) | REFUSED `164 … Cannot execute query in readonly mode` |
| `SHOW USERS`, `SELECT … FROM system.users` | ALLOWED (new since 0.12.6 — names only) |
| `url('http://…')` | REFUSED `497 … Not enough privileges` |
| `file('/etc/hostname')` | REFUSED `291 ACCESS_DENIED` |
| **`remote('127.0.0.1:9000', 'system','one', 'default', '…')`** | **ALLOWED — returns the row** |
| `remote('192.0.2.7:9000', …)` | `519 NetException … Timeout` — *dialed*, not denied |
| `cluster('test_shard_localhost', …)` | `701` unknown cluster — the access type is not the blocker |

And the argument shapes:

| Shape | Result |
|---|---|
| `remote(<literal>, …, <literal password>)` | dialed |
| `remote(<literal>, …, (SELECT 'stolen'))` | **dialed** — the password argument folds a subquery |
| `remote((SELECT '…'), …)` / `remote(concat(…), …)` | `36 … Hosts pattern must be string literal` |

So: the host must be written into the SQL as a literal, but a **data-dependent value
can be carried out in the password argument**. `readonly` does not bound this — it is
a SELECT.

**What this changes.** Section "What this establishes" #1 said a member "already cannot
dial out", and that premise is what cut P2 (the SQL-parser extraction) for the MCP `sql`
tool. `GRANT REMOTE ON *.*` — added so `memhouse relocate` can pull over `remoteSecure()`
— revoked it for every member on every surface, not just MCP: `/mem:sql` curls the same
credential with `readonly=1` and reaches exactly as far.

**Not introduced by this branch.** The reach ships in master today via `/mem:sql`. The
options are the pilot's: narrow the grant to when relocate actually needs it, deny
`remote`/`remoteSecure`/`cluster`/`clusterAllReplicas` at the application layer on
agent-facing surfaces (against the "ClickHouse enforces" ruling, but defence in depth),
or accept and document it. Nothing here is decided.

Everything else in this file re-verified unchanged: `url()`/`file()` still fenced,
delegation still cannot widen, `readonly` still unpinnable by the client.
