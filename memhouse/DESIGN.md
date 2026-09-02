# memhouse — design

**memhouse** is agent conversation memory as a product: every coding-agent session
on your machines — across **all 17 editors** agentlytics supports — parsed locally,
shipped to a typed ClickHouse store, shareable with a team, installable on the
ultimagent kernel as an **agency**, and visible through the agentlytics dashboard.

**A house is a database; its rooms are tables** — `sessions`, `messages`, `tool_calls`.
The server-stamped `user_id` says who wrote a row, the install fingerprint `host` says
which machine.

**What a member owns inside a house is the layout's whole question, and it has three
answers, two of them retired.** Shared tables with row policies fell in 0.4.0 (policies
are permissive and OR'd — a catch-all fails OPEN). Per-member suffixed rooms fell in
0.8.0, on the argument that isolation between housemates solved an adversarial problem
the product did not have. That argument was wrong, and the counter-example is measured:
with everyone holding `ALL ON db.* WITH GRANT OPTION`, one member ran
`GRANT SELECT ON db.* TO <outsider>` and handed over a housemate's transcripts — no
admin, no notification.

So the layout today is per-member rooms again, prefixed rather than suffixed, and with
the invariant the earlier attempt lacked: **a database has ONE owner or per-member rooms,
never both.** A member owns a house of their own (`alice.messages`) or their own rooms in
a shared one (`mem.alice_messages`); `roomNames()` in `house/house.js` is the only place
in the codebase that spells a table name.

The two objections that retired the 0.8.0 layout were real and are paid again here:
clients must resolve names before querying (`memhouse rooms`, and the `q()` helper the
skills route through), and reading across members needs a `UNION ALL` rather than one
table. Both are cheaper than the leak.

**Why grants and not policies.** A grant is something a colleague can verify for
themselves — `SHOW GRANTS` lists their rooms, and `SHOW TABLES` does not show them what
they were not granted. "Trust the row policy protecting your rows" is a sentence you
cannot ask a teammate to accept when "here are your grants, check them" is available.

**Agency, precisely.** In constellation terms (`../TERMINOLOGY.md`) memhouse is a
**house** — the `mem` database — **plus a resident**: the shipper. That pairing
is what the word *agency* means; a house on its own only holds.

The test is mechanical — **residents write, routines read**. The shipper fires on a
trigger no query supplies (its own loop) and produces writes that outlive the call:

```toml
[[resident]]
kind = "worker"    # deterministic code, no LLM
on   = "loop"      # a daemon — not an insert trigger, not a schedule
```

The session rollup is a **routine** — house machinery, not a second resident. Since
0.4.0 it is not even an object: it is SQL text (`house/house.js`), computed during your
query, for your query, writing nothing. memhouse has **no materialized views at all** — in fact no stored views at all
— so the shipper is not merely a resident, it is the only candidate in the tree. Strip
it and every remaining moving part is a routine over rows nobody is writing any more.

Note that `user_id MATERIALIZED currentUser()` is a materialized *column*: it computes
during your own insert and is part of the table's definition. It is what tells housemates'
rows apart in the shared tables — provenance, stamped by the server, with async_insert
pinned so it cannot be skipped. An identity property, not what makes this an agency.

**Positioning:** an alternative agency **competing with memory-house**. It borrows
memory-house's proven ideas (server-stamped identity, idempotent shipping,
skills/plugin delivery) and agentlytics' proven assets (adapters, UI, cost engine) —
but **not** its row-policy machinery: memhouse's tables are shared by people who chose
one house, and the boundary between houses is the database itself. If it wins, it can become memory-house v4; until then the
two run side by side as separate agencies, each in its own house. Naming: the product is
**memhouse**; the agency is **`memhouse`** and its house is the **`mem`** database
(identifiers can't carry a dash; the owner kept the longer name, `memhouse_root`).

## The four bets

`COMPETITION.md` grades each of these against the field as surveyed 2026-08-07.
Short version: bets 1, 2 and 4 are occupied by shipping competitors, several of
them free and further along; **bet 3 is the one nobody else attempts.**

1. **Parse on the client.** memory-house ships raw transcript lines and parses in
   views — workable only because its 4 agents store sessions as JSON/JSONL files.
   agentlytics' breadth includes sqlite-backed editors (Cursor, VS Code, Zed,
   Devin…) where no "raw line" exists; the adapter must crack a DB. So client-side
   parsing is not a style choice — it is what unlocks 17-editor coverage. The
   shipper runs the adapters (`editors/`) and ships **typed rows**. On the canon's
   write axis this bet is precisely *moving work from routine to resident*:
   memory-house parses when you query, memhouse parses before anyone asks and
   writes the result down.
2. **Typed common schema** (`house/schema.sql.tpl` — the rooms, rendered per member).
   Physical typed columns (what memory-house derives in views) + `tool_calls`
   (memory-house has no tool table) + one `extra JSON` escape hatch per room so
   unnormalized adapter fields are never lost. `ReplacingMergeTree(ingested_at)`;
   `messages` keyed `(session_id, user_id, origin, epoch, seq)` so a re-ship of a
   grown session replaces stale rows (latest-wins), two housemates' rows never
   collapse into one, and a re-parse that SHRANK or was rewritten lands under a new
   epoch instead of over what it replaces. FTS text indexes built in (CH ≥ 26.2).
3. **Kernel-installable agency.** Joining any ClickHouse — a kernel's included — is a
   database plus a credential: `CREATE USER`, `GRANT ALL ON <house>.* `, done. The
   shipper is the resident that lands with it and creates its own rooms. Identity is
   `user_id MATERIALIZED currentUser()` with `async_insert = 0 CONST` pinned on the
   user; machines are told apart by the `host` fingerprint. The boundary between
   agencies on one server is the database — a house's ALL reaches nothing outside it.
4. **Borrowed UI, zero fork.** The React SPA consumes REST JSON, not tables. The
   memhouse server implements the **same `/api/*` contract** as agentlytics'
   `server.js` (same routes, same response shapes) over the memhouse schema, and
   serves the same built `public/` bundle. UI changes: none.

## Components (this directory)

| Path | What | Notes |
|---|---|---|
| `house/house.js` | room names + the session rollup + the user pin | one rule for both transports |
| `house/schema.sql.tpl` | the rooms (typed) | applied by the member's shipper, or by the operator at invite in a shared house |
| `house/HOUSE.md` | the model, and what it replaced | |
| `shipper/ship.js` | parse-on-client shipper CLI — the resident (`worker`) | reuses `../../editors`; incremental; idempotent |
| `server/server.js` | REST API + dashboard | same API contract as agentlytics; serves `../../public` |
| `delivery/` | delivery kit | installer, skills, plugin, AGENT-INSTALL.md, prompt |
| `COMPETITION.md` | the competitive landscape, graded against the four bets | surveyed 2026-08-07; figures decay, re-run before citing |

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
- **The shipper is insert-only, and nothing may reintroduce a destructive verb.**
  `ReplacingMergeTree` collapses same-key rows but cannot remove a row the new parse no
  longer produces, so a shrunken re-parse leaves a stale `seq` tail. The shipper used to
  clear the session's rows first; that destroyed content held nowhere else, because
  Claude Code compacts transcripts and deletes them after `cleanupPeriodDays` (30 by
  default), and a shorter re-parse cannot be told apart from a fixed adapter bug. Instead
  `decideEpoch` bumps the session's `epoch` when the new parse is shorter than the stored
  one, or diverges from it at an overlapping `seq` (compared on the stored `line_hash`),
  and writes underneath the old parse rather than over it.
- **memhouse is an accumulator, not a mirror.** Absence of a session on disk is never a
  signal: retention cleanup, a manual delete, a second laptop, an unmounted folder, a
  locked SQLite file and a thrown adapter all produce the identical observation. A
  session that disappears is never cleared and never re-inserted. **No `sync` and no
  `prune` feature may be built here** — either would destroy the archive by design.
- Reads see one parse per session. `roomNames()` resolves `messages`/`tool_calls` to a
  current-epoch subquery and the bare tables only as `*_raw`, so retention cannot silently
  inflate a rollup, and a read path written by someone who has never heard of epochs is
  still correct. Measured cost of the filter: **+10 ms** across the dashboard's queries on
  a real 66k-message house (all of them under 200 ms), and **+13–37 ms** on a synthetic
  1M-message / 20k-session one. The single shape that grows is a one-session read
  (5 ms → 18 ms at 1M rows): the `IN` aggregates the whole room regardless of the outer
  session filter. If that ever matters, the answer is a small materialized current-epoch
  table maintained by the shipper — never a filter each caller has to remember.
- **A mutation predicate must bind the user, never call `currentUser()`.** No mutation
  survives in the shipper, but the finding outlives it — `migrate-rooms` and `reset` still
  run statements where it applies. A mutation does not evaluate `currentUser()` in the
  caller's context: measured on ClickHouse 25.11 and chdb, the same `DELETE` matched 0
  rows with `user_id = currentUser()` and 2000 with the value bound — silently, both
  times. Read the identity once (`SELECT currentUser()`) and pass it as a query parameter.
  The same trap bites the other way in a rebuild: `user_id` is `MATERIALIZED
  currentUser()`, so an `INSERT SELECT` that does not carry it explicitly (under
  `insert_allow_materialized_columns=1`) restamps every copied row with whoever ran the
  migration.
- Costs are computed in the server from `pricing.js` (repo root) over per-model
  token sums; `<synthetic>` and empty models excluded from model lists.

## Delivery kit (mirrors memory-house)

`AGENT-INSTALL.md` (agent-facing install steps), `plugin/` (the Claude Code plugin
wrapping the three skills), `PROMPT.md` (system-prompt snippet teaching an agent to
use memhouse as memory), `kernel-install.md` (provision as agency `memhouse`).

**`install.sh` is retired.** It was a second implementation of `memhouse install`,
maintained separately and drifting apart from it: by the end it still defaulted to
`http://localhost:8123` as `memhouse_root` — precisely the guessed house the CLI now
refuses on purpose, because on many machines that credential reaches a real house
belonging to someone else. One installer, and it is the one the acceptance suite
drives.

## Non-goals (v0)

Relay/team-server (per-room grants plus the `Merge` rooms already cover sharing),
migration tooling from memory-house's `memory` db, and per-adapter true message
timestamps.

OS-level daemonization **was** a non-goal — "ship `--loop` instead" — and is no longer:
`memhouse service install` writes a systemd `--user` unit or a launchd LaunchAgent. The
reason the non-goal did not survive is that `--loop` outlives the shell and nothing else,
so a machine that reboots stops shipping until somebody notices.
