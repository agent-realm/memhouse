# mem-house — design

**mem-house** is agent conversation memory as a product: every coding-agent session
on your machines — across **all 17 editors** agentlytics supports — parsed locally,
shipped to one typed ClickHouse store, shareable with a team, installable on the
ultimagent kernel as an **agency**, and visible through the agentlytics dashboard.

**Positioning:** an alternative agency **competing with memory-house**. It borrows
memory-house's proven ideas (server-stamped identity, own-only RLS, idempotent
shipping, skills/plugin delivery) and agentlytics' proven assets (adapters, UI,
cost engine). If it wins, it can become memory-house v4; until then the two run
side by side as separate agencies, each in its own house. Naming: the product is
**mem-house**; ClickHouse identifiers use **`memhouse`** (agency/house name, owner
`memhouse_root`) since identifiers can't carry a dash.

## The four bets

1. **Parse on the client.** memory-house ships raw transcript lines and parses in
   views — workable only because its 4 agents store sessions as JSON/JSONL files.
   agentlytics' breadth includes sqlite-backed editors (Cursor, VS Code, Zed,
   Devin…) where no "raw line" exists; the adapter must crack a DB. So client-side
   parsing is not a style choice — it is what unlocks 17-editor coverage. The
   shipper runs the adapters (`editors/`) and ships **typed rows**.
2. **Typed common schema** (`schema.sql`). Physical typed columns (what
   memory-house derives in views) + `tool_calls` (memory-house has none) + one
   `extra JSON` escape hatch per table so unnormalized adapter fields are never
   lost. `ReplacingMergeTree(ingested_at)`; `messages` keyed `(session_id, seq)` so
   a re-ship of a grown/changed session replaces stale rows (latest-wins). FTS text
   indexes built in (CH ≥ 26.2).
3. **Kernel-installable agency.** Same install path proven for agentlytics-agency:
   `install-agency{memhouse}` → house + `memhouse_root` + credential; members via
   `register-member` + owner `GRANT`; own-only visibility via the kernel-applied
   row policy (`rls.sql`). Identity is `user_id MATERIALIZED currentUser()`
   (requires `async_insert=0`). Sharing modes: own-only (policy TO member) or
   team-pool (no policy).
4. **Borrowed UI, zero fork.** The React SPA consumes REST JSON, not tables. The
   mem-house server implements the **same `/api/*` contract** as agentlytics'
   `server.js` (same routes, same response shapes) over the mem-house schema, and
   serves the same built `public/` bundle. UI changes: none.

## Components (this directory)

| Path | What | Notes |
|---|---|---|
| `schema.sql` | the house schema (typed) | unqualified names; owner applies in its house |
| `rls.sql` | own-only row policies | kernel/mayor applies (owner lacks ACCESS MANAGEMENT) |
| `shipper/ship.js` | parse-on-client shipper CLI | reuses `../../editors`; incremental; idempotent |
| `server/server.js` | REST API + dashboard | same API contract as agentlytics; serves `../../public` |
| `delivery/` | delivery kit | installer, skills, plugin, AGENT-INSTALL.md, prompt |

## Environment contract

| Var | Default | Meaning |
|---|---|---|
| `MEMHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP(S) endpoint |
| `MEMHOUSE_USER` | `memhouse_root` | CH user (owner, or a member's own credential) |
| `MEMHOUSE_PASSWORD` | *(empty)* | credential |
| `MEMHOUSE_DB` | `memhouse` | the house |
| `MEMHOUSE_PORT` | `4640` | dashboard/API port |

Config file: `~/.memhouse/config.json` (`hiddenProjects`, future prefs).

## Data-plane rules (binding for the shipper and server)

- Inserts: `JSONEachRow`, batches ≤ 2000 rows, **`async_insert=0` always** (else
  `user_id` stamping breaks). Reads: set `final: 1` so ReplacingMergeTree collapses.
- All Int64-bound values coerced to integers (some adapters emit fractional ms).
- Per-message `ts`: interpolated across the session's `[createdAt, lastUpdatedAt]`
  (adapters don't expose per-message timestamps; monotonic by `seq`; documented
  approximation, refine per-adapter later).
- `seq` is the message index within the session (0-based). `tool_calls.idx` is the
  call index within the session. `is_subagent` = message content begins with
  `[subagent]` (the fold marker from the Claude adapter).
- Incremental shipping: read existing `(session_id, last_updated_at, message_count)`
  (FINAL) and skip chats that haven't grown/changed; a full re-ship must remain
  safe (ReplacingMergeTree collapses).
- Costs are computed in the server from `pricing.js` (repo root) over per-model
  token sums; `<synthetic>` and empty models excluded from model lists.

## Delivery kit (mirrors memory-house)

`install.sh` (standalone), `AGENT-INSTALL.md` (agent-facing install steps),
`skills/` (Claude Code skills to query/search mem-house), `plugin/` (Claude Code
plugin wrapping the skills), `PROMPT.md` (system-prompt snippet teaching an agent
to use mem-house as memory), `kernel-install.md` (provision as agency `memhouse`).

## Non-goals (v0)

Relay/team-server (the kernel + RLS already covers sharing), launchd daemonization
(ship `--loop` instead), migration tooling from memory-house's `memory` db, and
per-adapter true message timestamps.
