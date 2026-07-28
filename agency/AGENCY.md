# agentlytics as an ultimagent kernel agency

This wraps agentlytics as an **agency** on the ultimagent kernel: instead of a
standalone local dashboard over a private SQLite/ClickHouse cache, agentlytics'
17-editor session ingestion becomes a capability *inside a realm*, writing into a
kernel-provisioned **house** using the realm's session schema.

## The model (kernel vocabulary)

See `../TERMINOLOGY.md` for the canon.

- **realm** — one deployment. **town** — the ClickHouse server instance it runs on,
  promoted into a kernel.
- **ego** — the `kernel` CH user, the realm's non-interactive executive; answers a
  closed, parameterized syscall catalog and never reads content.
- **house** — a database. **agency** — a house *plus the residents working in it*. An
  install lands both: the house (a database) + an owner user (`<name>_root`) + owner
  grants, and the resident that actually does the work. agentlytics is an agency
  because of `ingest.js`; the database alone would just be a house.
- **resident** — something that fires on a trigger and **writes**. Here there is exactly
  one: the deterministic ingest loop (`kind = "worker"`, `on = "loop"` — no LLM). The
  test is mechanical: *does it produce a write?*
- **routine** — something called that returns, changing nothing. The derived
  `messages_v` / `sessions_v` are plain views, so they are routines: house machinery,
  not residents. There are no materialized views here at all.
- **mayor** — the **human** owner who approves installs; holds a real superuser
  credential, and is not a ClickHouse user the kernel mints.
- **member** — a joined CH user.

## Two halves

**1. Provision (operator, one-time)** — done via the kernel, not this repo. From the
kernel checkout:

```bash
python3 executor/executor.py provision agentlytics
```

That submits `install-agency{name:'agentlytics'}`, the mayor (the human owner) approves,
and the executor (running as the ego, the `kernel` user) creates: database `agentlytics`
(the house), owner `agentlytics_root` (scoped `realm_user` profile), and owner grants on
the house. It returns a one-time **credential** — rotate it on first connect.

**2. Run the agency (this repo)** — `agentlytics_root` connects to its house, creates
the session schema, and ships local editor sessions into it. The kernel never runs or
reads this; it is the agency's own resident — a deterministic `worker` on a loop,
writing rows nobody queried for. This half is what makes the install an agency rather
than an empty house.

```bash
export HOUSE_CLICKHOUSE_URL=https://<kernel-host>:8443
export HOUSE_CLICKHOUSE_USER=agentlytics_root
export HOUSE_CLICKHOUSE_PASSWORD=<credential-from-provision>
export HOUSE_CLICKHOUSE_DATABASE=agentlytics
node agency/agency.js          # one pass   (--loop to re-ingest every 60s)
```

Then query the realm session store as any member/owner:

```sql
SELECT source, count() FROM agentlytics.sessions_v GROUP BY source;
SELECT session_id, source, project, started, assistant_msgs, input_tokens, first_prompt
FROM agentlytics.sessions_v ORDER BY started DESC LIMIT 20;
```

## What it produces (`agency/house-schema.sql`)

The house mirrors memory-house's realm session schema — `raw` (6 client columns +
server-stamped `user_id MATERIALIZED currentUser()`, `ReplacingMergeTree`) plus the
derived `messages_v` and `sessions_v` views. The **difference and the value-add**:
memory-house ships editor-native raw lines and its views are Claude-shaped (FTS
filtered to `source='claude-code'`, ~4 agents); this agency emits a **canonical `data`
shape normalized across all 17 editors** agentlytics supports (`agency/ingest.js`
reuses the adapters' `getAllChats`/`getMessages`), so `messages_v`/`sessions_v`
populate uniformly for editors memory-house cannot cover. The two agencies converge at
the schema level — each in its own house.

## Multiple members + shared memory (the memory-house model)

memory-house's multi-tenant model — many people, each with their own credential, each
seeing only their own sessions (own-only RLS) — is reproducible here. Most of it
already works in what this agency ships; exactly one step belongs to the kernel.

| Piece | Who does it | Status |
|---|---|---|
| Mint a member (a CH user) | **the ego** (`kernel`) — `register-member{handle}` | works |
| Let a member read/write the house | **owner** — `GRANT INSERT, SELECT ON agentlytics.* TO handle` | works |
| Stamp each row's writer identity | **schema** — `user_id MATERIALIZED currentUser()` | works |
| Each member ingests as themselves | **member** — run `agency.js` with their own `HOUSE_CLICKHOUSE_USER/PASSWORD` | works |
| **Own-only RLS (row policy)** | **kernel** — the owner CANNOT (`CREATE ROW POLICY` needs ACCESS MANAGEMENT) | **the gap** |

The only missing capability is installing the row policy in `house-rls.sql`, and it is
deliberately the kernel's — agency owners are denied ACCESS MANAGEMENT by design. Two
ways to close it:

- **Kernel verb (clean).** Add a closed, parameterized, owner-approved catalog verb
  (the SPEC §6 grant/capability family, design-only in M1) the kernel runs as `kernel`:
  `grant-house-access{agency, member}` → the owner-grant above; and
  `set-house-visibility{agency, mode: own-only|shared}` → installs/removes the row
  policy. Both are content-blind and fit the model — a ~10-line addition to the
  executor's `expand()`.
- **Mayor applies it once (interim).** The mayor — the human owner, holding a real
  superuser credential and therefore ACCESS MANAGEMENT — runs `house-rls.sql` after
  install. Works today.

Verified end-to-end on a throwaway kernel: two members ingesting as themselves each saw
only their own rows (alice→2, bob→1); the owner (outside the policy) saw all; the
owner's own attempt to create the policy was correctly denied.

## Design notes

- **Deterministic worker (agent-desk tier).** `ingest.js` is a resident with
  `kind = "worker"`, not `"agent"`: it runs no LLM, so it is not a prompt-injection
  surface — it only reads local files and INSERTs rows.
- **Un-spoofable identity.** `user_id = currentUser()` is stamped by the DB; the worker
  must insert with `async_insert=0` (enforced here) or identity would be lost. This is a
  materialized *column* — part of the table, computed during the worker's own insert.
  It governs attribution and blast radius, a different axis from residency.
- **Idempotent.** Re-runs collapse via `ReplacingMergeTree` on
  `(sessionId, timestamp, uuid, line_hash)`; no cursor state required for correctness.
- **RLS / multiple writers are the kernel's job.** The kernel-issued owner has
  grant-option on its house but not `ACCESS MANAGEMENT`, so per-member identities come
  from the kernel (`register-member`) and the owner then `GRANT INSERT` — added when
  the agency serves more than its owner.
- **Not touched:** the standalone dashboard (`index.js`/`server.js`) and its private
  ClickHouse cache still work as before; this agency is an additional, realm-native
  output path for the same adapters.
