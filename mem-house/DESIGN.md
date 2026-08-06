# mem-house — design

**mem-house** is agent conversation memory as a product: every coding-agent session
on your machines — across **all 17 editors** agentlytics supports — parsed locally,
shipped to one typed ClickHouse store, shareable with a team, installable on the
ultimagent kernel as an **agency**, and visible through the agentlytics dashboard.

**Agency, precisely.** In constellation terms (`../TERMINOLOGY.md`) mem-house is a
**house** — the `memhouse` database — **plus a resident**: the shipper. That pairing
is what the word *agency* means; a house on its own only holds.

The test is mechanical — **residents write, routines read**. The shipper fires on a
trigger no query supplies (its own loop) and produces writes that outlive the call:

```toml
[[resident]]
kind = "worker"    # deterministic code, no LLM
on   = "loop"      # a daemon — not an insert trigger, not a schedule
```

`sessions_v` is a plain view: computed during your query, for your query, writing
nothing. It is a **routine** — house machinery, not a second resident. mem-house has
**no materialized views at all**, so the shipper is not merely a resident, it is the
only candidate in the tree. Strip it and every remaining moving part is a routine
over rows nobody is writing any more.

Note that `user_id MATERIALIZED currentUser()` is a materialized *column*: it computes
during your own insert and is part of the table's definition. It makes own-only RLS
work and it records who wrote each row, but it is an identity property, not what makes
this an agency.

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
   shipper runs the adapters (`editors/`) and ships **typed rows**. On the canon's
   write axis this bet is precisely *moving work from routine to resident*:
   memory-house parses when you query, mem-house parses before anyone asks and
   writes the result down.
2. **Typed common schema** (`schema.sql`). Physical typed columns (what
   memory-house derives in views) + `tool_calls` (memory-house has none) + one
   `extra JSON` escape hatch per table so unnormalized adapter fields are never
   lost. `ReplacingMergeTree(ingested_at)`; `messages` keyed `(session_id, seq)` so
   a re-ship of a grown/changed session replaces stale rows (latest-wins). FTS text
   indexes built in (CH ≥ 26.2).
3. **Kernel-installable agency.** Same install path proven for agentlytics-agency:
   `install-agency{memhouse}` → house + `memhouse_root` + credential; members via
   `register-member` + owner `GRANT` on that member's own rooms. Own-only visibility
   needs no policy: a member is granted their rooms and nobody else's. The shipper is
   the resident that lands with it. Identity is `user_id MATERIALIZED currentUser()`
   (requires `async_insert=0`). Sharing is a further GRANT, issued by the member
   themselves (grant-option) or the owner.
4. **Borrowed UI, zero fork.** The React SPA consumes REST JSON, not tables. The
   mem-house server implements the **same `/api/*` contract** as agentlytics'
   `server.js` (same routes, same response shapes) over the mem-house schema, and
   serves the same built `public/` bundle. UI changes: none.

## Components (this directory)

| Path | What | Notes |
|---|---|---|
| `per-member/rooms.js` | room-name resolution + the session rollup | one naming rule for both transports |
| `per-member/schema-member.sql.tpl` | one member's three rooms (typed) | the owner via `provision.js`, or the member on a house they own |
| `per-member/schema-merge.sql.tpl` | the three team Merge rooms | owner-managed; reduce to the caller's grants |
| `shipper/ship.js` | parse-on-client shipper CLI — the resident (`worker`) | reuses `../../editors`; incremental; idempotent |
| `server/server.js` | REST API + dashboard | same API contract as agentlytics; serves `../../public` |
| `delivery/` | delivery kit | installer, skills, plugin, AGENT-INSTALL.md, prompt |

## Environment contract

| Var | Default | Meaning |
|---|---|---|
| `MEMHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP(S) endpoint |
| `MEMHOUSE_USER` | `memhouse_root` | CH user (owner, or a member's own credential) |
| `MEMHOUSE_PASSWORD` | *(empty)* | credential |
| `MEMHOUSE_DB` | `mem` | the house |
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
- Re-shipping a known session **deletes its message/tool rows first**: `ReplacingMergeTree`
  collapses same-key rows but cannot remove a row the new parse no longer produces, so a
  shrunken re-parse would leave a stale `seq` tail forever.
- **A mutation predicate must bind the user, never call `currentUser()`.** A mutation does
  not evaluate it in the caller's context: measured on ClickHouse 25.11 and chdb, the same
  `DELETE` matched 0 rows with `user_id = currentUser()` and 2000 with the value bound —
  silently, both times. Read the identity once (`SELECT currentUser()`) and pass it as a
  query parameter. This applies to `DELETE`/`ALTER … UPDATE`, not to `SELECT`, where
  `currentUser()` behaves as expected.
- Costs are computed in the server from `pricing.js` (repo root) over per-model
  token sums; `<synthetic>` and empty models excluded from model lists.

## Delivery kit (mirrors memory-house)

`install.sh` (standalone), `AGENT-INSTALL.md` (agent-facing install steps),
`skills/` (Claude Code skills to query/search mem-house), `plugin/` (Claude Code
plugin wrapping the skills), `PROMPT.md` (system-prompt snippet teaching an agent
to use mem-house as memory), `kernel-install.md` (provision as agency `memhouse`).

## Non-goals (v0)

Relay/team-server (the kernel + RLS already covers sharing), migration tooling from
memory-house's `memory` db, and per-adapter true message timestamps.

OS-level daemonization **was** a non-goal — "ship `--loop` instead" — and is no longer:
`memhouse service install` writes a systemd `--user` unit or a launchd LaunchAgent. The
reason the non-goal did not survive is that `--loop` outlives the shell and nothing else,
so a machine that reboots stops shipping until somebody notices.
