# memhouse mcp — build plan

An MCP server over the memhouse house, targeting the **2026-07-28 revision** — the
stateless one. The Claude Code skills reach only Claude Code; MCP reaches every other
client memhouse already parses. We read 17 editors' memories; MCP lets all of them
read them back.

Companions in this directory: `SPEC-2026-07-28.md` (what the revision requires and how
it differs from the handshake era), `ARCHITECTURE.md` (module layout and a worked
stdio flow), `GRANTS.md` (what ClickHouse enforces, tested).

Written 2026-08-16 against master `b78b342` (0.9.0); every line number cited below was
verified there. Branch `claude/mcp-server`.

**Status 2026-08-18: P3–P6 and P8 BUILT, tested, green.** `tools.js` (six tools),
`rpc.js` (dual-era protocol, shared scrub), `stdio.js`, `POST /mcp` on the dashboard
server, `case 'mcp'` in the CLI, MCP read functions in `server/queries.js`, README
section, CHANGELOG entry. Test coverage, all green:

- `npm test` — 16 protocol unit checks (`misc/mcp-unit-test.js`): result shapes, the
  era split, -32022/-32601/-32602/-32600, deterministic order, id edge cases, the
  version gate running before dispatch, the no-house refusal.
- `misc/mcp-test.js` — 27 live stdio checks over a throwaway house: the tool flows,
  LIKE-metacharacter literalness, the multi-holder ambiguity answer, truncation
  flags, server-side readonly refusal verbatim, caps actually cutting (this battery
  caught `result_overflow_mode: 'break'` not cutting inside one block — fixed with
  an exact JS slice over the server bound), scrub holding even when a result
  legitimately selects the password, concurrency, era persistence, -32700 recovery,
  clean EOF, no-house.
- `misc/mcp-http-test.js` — 14 live HTTP checks against the real dashboard process:
  header↔body validation (-32020, base64 sentinel decoded), hostile Origin 403,
  unknown method 404/-32601, unknown version 400/-32022, GET/DELETE 405,
  Mcp-Session-Id ignored and never echoed, notifications 202, the legacy flow in
  legacy shapes, credential never on the wire, and the dashboard still answering
  from the same pid.
- The P5 real-client gate: Claude Code via `--mcp-config` drove
  search → get_session → resume_command and reported the right session, content,
  and resume command.

Remaining: P6b (credential surface — parent repo), P7 (resources — not earned yet),
`agy` review before merge.

One deviation from the letter of this plan, kept deliberately: `rpc.js` is
**dual-era** — it also answers the legacy `initialize` handshake, because every
client in the field today (Claude Code included) still opens with it. The spec
blesses dual-era servers; our tools surface is identical under both, so legacy is a
result shape, not a behavior. The P5 gate ran through that path.

## What the repo already gives us

| Seam | Where | Note |
|---|---|---|
| read layer | `memhouse/server/queries.js` | `getChat`/`rawQuery`/`schema`; rooms resolved once; env read **at require time** |
| result caps | `queries.js:919–936` | rows/bytes/exec-time/memory, `result_overflow_mode: break` |
| config | `bin/memhouse.js:29,58,86` | flags → `MEMHOUSE_*` → `$MEMHOUSE_HOME/env`; the refusal text |
| search SQL | `bin/memhouse.js:1520` | `text_ngram LIKE`, GROUP BY session_id |
| resume | `memhouse/resume.js` | `resumeFor()` — already pure |
| CLI dispatch | `bin/memhouse.js:2035` | add `case 'mcp'` |
| SQL parser | `memhouse/server/server.js:194–363` | stays where it is — see below. **Not** an MCP dependency |

Two facts the plan turns on:

1. **The SQL parser is not ours to carry.** Authorization belongs to the pilot's
   ClickHouse GRANTs, not to a parser in the application.
2. **CLI and dashboard use different query paths.** MCP takes `queries.js`, with the
   resolved config stamped into `process.env` *before* the require.

## Who protects the house

Install is two statements (`bin/memhouse.js:642`): `CREATE USER` +
`GRANT ALL ON <house>.*` — a **database-level** grant. Tested on ClickHouse 26.7: it
confers nothing global. No `URL`, no `FILE`, no `REMOTE`/`S3`, no access management,
no other database. A normal member credential is already refused `url()` by the
server, so the table-function parser re-derives a refusal ClickHouse issues on its
own, with a better message than ours.

The parser earns its keep in exactly one place, and it is not this one:

| Caller | Holds the credential | Boundary? |
|---|---|---|
| `/api/query` — unauthenticated bound port, any local process, any page via DNS rebinding | memhouse | **yes** — confused deputy: memhouse acts for a caller with no credential |
| MCP stdio | the client that spawned us, from its own environment | **no** — the caller *is* the credential holder |

An agent on stdio can run `clickhouse-client` with the same env. A parser in
`tools.js` protects nothing and refuses queries the pilot's own grants permit — that
is memhouse overriding the pilot.

**Framing correction.** "Read-only by enforcement, not convention" was wrong about
*who* enforces. **ClickHouse enforces; memhouse declares** and passes the server's
refusal through (`Code: 164 … Cannot execute query in readonly mode`,
`Code: 497 … Not enough privileges`). The plugin skills already work this way —
`readonly=1` pinned on the request URL, no parser.

---

## P0 — spec ground truth · **DONE 2026-08-16**

Read from the spec. The parts that bind us:

- No `initialize`, no sessions. Every request carries
  `io.modelcontextprotocol/protocolVersion`, `clientCapabilities`, `clientInfo` in
  `_meta`. Results carry `serverInfo` in `_meta` and a required `resultType`.
- `server/discover` is **MUST-implement**; result shape confirmed
  (`supportedVersions`, `capabilities`, `instructions`, `ttlMs`, `cacheScope`).
- `CacheableResult` (`ttlMs` + `cacheScope`) **required** on `tools/list` and
  `resources/read`. `tools/list` SHOULD be deterministic-ordered.
- Errors: `-32022` unsupported version, `-32020` header mismatch, `-32602`
  resource-not-found, `-32601` unknown method.
- **Not needed by us at all**: MRTR (`input_required`), `subscriptions/listen`,
  Roots, Sampling, Logging. Read-only tools ask the client for nothing.

**Decision: hand-roll, no SDK.** `rpc.js` is a few hundred lines against a protocol
with no handshake and no session. The repo has three dependencies and a minimal-deps
culture; the 2026-07-28 SDKs are beta. The tool layer stays protocol-agnostic so an
SDK swap — or a fallback to 2025-11-25 — is one file.

**Auth, settled by the spec itself:** stdio implementations **SHOULD NOT** do OAuth
and **SHOULD take credentials from the environment**. Exactly what `resolveConfig()`
already does. v1 has no auth work, by the book.

## P1 — worktree + throwaway house

```
git -C ~/agent-realm/memhouse worktree add \
  ~/agent-realm/.worktrees/memhouse/claude/mcp-server -b claude/mcp-server
```

Throwaway ClickHouse in docker (`docker rm -f -v`, always `-v`), `MEMHOUSE_HOME` a
temp dir, fixture house seeded through the normal install path. **Never**
`localhost:8123` / `localhost:18999` — those are the pilot's real houses.

## P2 — extract the SQL guard · CUT 2026-08-16 · **REOPENED AND DONE 2026-08-22**

**Reopened.** The cut below rests on one fact — a member holds no global grant, so
ClickHouse itself refuses every way out of this server — and that fact was revoked
from outside while this branch sat unmerged. `memhouse relocate` pulls the source
house over `remoteSecure()`, so invite and install now grant every member
`REMOTE ON *.*`. Re-probed with `readonly=2` pinned: `remote()` returns rows, an
unreachable host times out instead of being denied, and the password argument folds a
subquery — a way out for anything the credential can read. `url()` and `file()` are
still refused; `remote()` is not.

So the guard was extracted after all, as `memhouse/server/sql-guard.js`: the same
construct-aware reader, moved out of the `/api/query` route and shared, plus unit
tests it never had on either surface (the four bypasses in its comments were all found
by hand). The MCP `sql` tool refuses any table function outside the allowlist and
keeps nothing else the route does — no statement-shape rule, no own-database
confinement, because reading a housemate's shared house by name is a feature here.
Everything below is the reasoning as it stood on 2026-08-16; it is kept because the
argument is still right about *authorization*, which is not what the guard does now.

Deleted, not deferred. The parser stays in `/api/query`; the MCP `sql` tool does not
call it. No `sql-guard.js`, no merge-order constraint on `server.js`, no second copy
of 170 lines of comment/heredoc evasion handling.

What the `sql` tool keeps instead — neither is authorization:

- **`readonly=1` per request.** Not protecting the house: declining to hand a
  write-capable credential a footgun, since MCP reads `$MEMHOUSE_HOME/env` where the
  shipper's `ALL` credential lives. Server-enforced, one setting. The pilot writes
  with their own client whenever they like.
- **The existing caps** (`max_result_rows`, `max_result_bytes`,
  `max_execution_time`, `max_memory_usage`). Self-protection: `q()` buffers every row
  into JS and `numbers(2000000000)` OOM'd the dashboard process. memhouse defending
  memhouse, not the house defending itself.

## P3 — tool layer, protocol-agnostic (`memhouse/mcp/tools.js`)

Six async functions over `queries.js` + `resume.js`. No JSON-RPC in scope.

| Tool | Built from | Notes |
|---|---|---|
| `search` | `cmdSearch`'s SQL, moved into `queries.js` as `searchSessions()` | compact index only — `session_id`, `user_id`, `source`, `project`, `at`, `hits`, 150-char snippet, **`est_expand_tokens`**. Never full text |
| `timeline` | `sessions_v` rollup | around a date, or ±N around a session |
| `get_session` | `getChat(id)` + `seq` range slice | the only tool returning transcript text |
| `stats` | `getOverview` / `getDashboardStats` | per-source/user/host counts + freshness |
| `resume_command` | `resumeFor()` | command, or the honest refusal. Prints, never runs |
| `sql` | `rawQuery` + `readonly=1` | **no parser.** The server's refusal is the answer; pass it through verbatim |

- **Config**: reuse the CLI resolution — extract `resolveConfig`/`requireConfig` from
  `bin/memhouse.js` into `memhouse/config.js`, stamp `process.env.MEMHOUSE_*`, then
  require `queries.js`. No house stated ⇒ the standard refusal verbatim; never touch
  `localhost:8123` uninvited.
- **Credentials are the pilot's lever, and the docs say so.** Tested on ClickHouse
  26.7: a SELECT-only user is refused `INSERT`, `DROP`, `TRUNCATE`, `ALTER … DELETE`,
  `url()`, other databases, `system.users`, `CREATE USER`, and self-escalation — all
  by the server, `Code: 497`. Ship the recipe, not a parser:
  `CREATE USER mem_reader …; GRANT SELECT ON mem.* TO mem_reader;` and point MCP at it.
- **The `sql` tool's description states the model of the world**: it runs under the
  caller's configured credential, and its limits are the pilot's grants. An agent that
  reads that description knows why a refusal is a refusal.
- **Bound params everywhere.** `cmdSearch` interpolates its needle into SQL. An MCP
  tool argument is attacker-shaped input in a way a CLI argument is not — it moves to
  a bound param when it moves into `queries.js`.
- **`est_expand_tokens`** is the differentiator: claude-mem *asserts* ~10x savings
  from progressive disclosure; we hand the model the number and let it choose. From
  stored token columns where present, char/4 otherwise.

## P4 — stdio transport + `memhouse mcp`

- `memhouse/mcp/rpc.js` — the only file that knows MCP exists. Reads `_meta`, writes
  `serverInfo` + `resultType: "complete"`, serves `server/discover` and `tools/list`
  (deterministic order, `ttlMs`, `cacheScope: "private"`), maps the error codes.
- `memhouse/mcp/stdio.js` — newline-delimited JSON-RPC on stdin/stdout. Exit on stdin
  EOF (the only portable graceful shutdown signal).
- `case 'mcp':` in the CLI switch.
- **stdout is protocol-only** — the spec's words: the server MUST NOT write anything
  to stdout that is not a valid MCP message. All logging to stderr. Our trap:
  `MEMHOUSE_DEBUG=1` un-silences the ClickHouse driver (`queries.js:34`). Test it.
- **No-house behaviour:** the process still starts; `server/discover` and `tools/list`
  answer (they need no house); a `tools/call` returns a tool result with
  `isError: true` carrying the refusal and its fix lines. Protocol errors are for
  protocol problems — a client that cannot even list the tools shows the user nothing
  but "server failed".
- `instructions` in the discover result is the cheapest lever in the surface: the
  paragraph every client puts in front of its model. Write it like a tool description,
  not a README.

## P5 — real-client verification · **hard gate**

Register the stdio server in Claude Code against the fixture house; run
`search` → `get_session` → `resume_command` end to end. Second client: the MCP
inspector. Paste the transcript into the session log. This repo's history says
untested layers hide one more swallow.

## P6 — Streamable HTTP, mounted on the existing dashboard app

Same `rpc.js`; the express route unwraps and calls it. `POST /mcp` only,
loopback-bound. No new daemon, no port-per-user, no worker — the competitor's
process-leak class must not be constructible here.

Five things the transport requires that stdio does not:

1. Required headers `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` — the server
   **MUST** validate each against the body. Mismatch ⇒ `400` + `-32020`. (A balancer
   routes on the header while the server executes the body; disagreement is an attack.)
2. **`Origin` MUST be validated**, `403` if invalid — DNS-rebinding defense. Bind
   127.0.0.1 only.
3. Unknown method ⇒ HTTP **`404`** + `-32601`. Unsupported version ⇒ `400` + `-32022`.
4. Legacy traffic: GET/DELETE ⇒ `405`; ignore any `Mcp-Session-Id` and never echo one;
   ignore `Last-Event-ID` — streams are not resumable.
5. `Accept` must list both `application/json` and `text/event-stream`; we may answer
   every request with a single JSON object (no SSE needed — nothing streams yet).

**Scope line to hold:** loopback-only means no auth, same posture as the dashboard
today. Serving a *team* house remotely turns us into a full OAuth 2.1 resource server —
protected resource metadata (RFC 9728), audience-bound tokens (RFC 8707), 401/403 scope
challenges. A project, not a phase. Do not promise it in v1.

## P6b — the credential surface (parent-repo work, not MCP)

Falls out of the grant findings; belongs in `memhouse` proper, and MCP is only its
first consumer. Sized small deliberately — one statement at install time is worth more
than any amount of parser.

- **`memhouse doctor` prints `SHOW GRANTS`** for the configured credential. The pilot
  sees what they handed over instead of assuming. Cheapest item here, and the one that
  turns the model from a doc into a visible fact.
- **Provisioning offers a reader.** `memhouse onboard` / `install` create
  `<house>_reader` with `GRANT SELECT ON <house>.*` alongside the owner, and print
  which credential belongs in which surface (shipper: owner; MCP/dashboard: reader).
- **Document `readonly = 1 CONST`** for the case where one credential must both ship
  and face an agent: pinned server-side, and the client cannot unpin it by `SET` or by
  query parameter (tested).
- **Document bounded delegation.** `GRANT CREATE USER, DROP USER ON mem_* TO alice`
  lets a house owner mint further narrow agent credentials without being able to touch
  `default` or anything outside the prefix — and a user can never grant more than it
  holds WITH GRANT OPTION, so delegation cannot widen.

## P7 — resources (optional)

Finished transcripts via `resources/read`, long `ttlMs`, `cacheScope: "private"`,
`-32602` when a URI is unknown. Only after P6, and only if a real client earns it.

## P8 — tests, docs, merge

- `misc/unit-test.js`: tool shapes, `est_expand_tokens` sanity, stdout purity under
  `MEMHOUSE_DEBUG=1`. (No guard-parity suite — there is no guard to port.)
- `tests/herdr-driven-acceptance.md` — new MCP phase:
  (a) no house ⇒ refusal, never `localhost:8123`;
  (b) **under a `mem_reader` credential**, a write through `sql` is refused by the
      SERVER and the `Code: 497` text reaches the caller intact — asserting the model,
      not a parser;
  (c) credentials appear in **no** result, error body, or log (grep);
  (d) stdout carries JSON-RPC and nothing else.
- README section + CHANGELOG entry. Review locally with `agy` (no Codex).
  `npm test` green before merge.

---

## Open questions (parent repo, recorded here)

### O1 — does the shipper actually need `DELETE`? (pilot, 2026-08-16)

`ship.js:757–781` runs `DELETE FROM <room> WHERE session_id = … AND user_id = … AND
origin = 'ship'` before re-inserting a known session. The stated reason
(`ship.js:673`, and the schema comments) is real and specific: **ReplacingMergeTree
collapses same-key rows only.** The sorting key is
`(session_id, user_id, origin, seq)`, so a re-parse that yields FEWER messages leaves
the old higher-`seq` rows with nothing to replace them — a stale tail that no merge
will ever remove. RMT deduplicates; it cannot delete.

That makes `ALTER DELETE` a live grant requirement for the shipping credential, which
is the one thing standing between memhouse and a shipper that only needs
`SELECT` + `INSERT`. Worth removing. Options, unevaluated:

- **VersionedCollapsingMergeTree** (pilot's suggestion). Cancels rows with a `sign=-1`
  twin instead of deleting. Removes the mutation — but the shipper must first LEARN
  which rows to cancel (a read), and VCMT does not dedupe two identical `sign=+1`
  rows the way RMT does, so today's free idempotence on re-ship is lost unless every
  re-ship cancels the whole prior set. Trades one problem for a heavier write path.
- **RMT soft-delete** — `ReplacingMergeTree(ingested_at, is_deleted)`, tombstone the
  stale tail. Keeps RMT's idempotence and the current engine. **TESTED 2026-08-16 on
  ClickHouse 26.7: `FINAL` suppresses `is_deleted = 1` rows by itself**, no read-side
  filter needed — and `queries.js` already runs everything with `final: 1`, so the
  read layer changes nothing. This is the cheap route. (Tombstoned rows stay on disk
  until a merge with cleanup — hidden, not gone.)
- **High-water mark** — store an authoritative `max_seq` per session and filter
  `seq <= max_seq` at read time. No engine change, no tombstones; dead rows linger on
  disk and every reader must remember the filter.

All three need the shipper to know the current state of a session. `loadExisting()`
already loads per-session metadata in one pass, so extending it with
`max(seq) GROUP BY session_id` is cheap — that part is not the obstacle.

**What the shipper actually exercises today** (audited `ship.js`):

| Verb | Where | Destructive? |
|---|---|---|
| `SELECT` | 331, 350, 499, 515, 528 | no |
| `INSERT` | 695 | no |
| `CREATE TABLE` (self-healing schema) | 402 | no — additive |
| `ALTER TABLE … ADD COLUMN IF NOT EXISTS` | 451, 464 | no — additive |
| **`DELETE FROM`** | **777** | **yes — the only one that can lose data** |

So removing the clear does not by itself make the shipper `SELECT` + `INSERT`-only —
schema self-healing still needs DDL, and getting rid of *that* means moving migrations
to the install/upgrade path under the owner credential. But it does remove the only
privilege whose misuse destroys rows, which is the whole point: after O1 a buggy
shipper cannot lose data, only add it.

### O2 — the source is not immutable, and that is the product

Established 2026-08-16 while working O1. Claude Code's `cleanupPeriodDays` defaults to
**30 days**: *"Claude Code deletes session files and other application data older than
this period at startup."* Checked against this machine — 25 transcripts, oldest
2026-07-14, nothing older. Compaction rewrites transcripts too, and a user can delete
one by hand.

Three consequences, none of them small:

1. **This is memhouse's sharpest argument.** The house outlives the source by design,
   and ~30 days is when the source evaporates on its own. It belongs in the README,
   stated plainly, with the setting named.
2. **The shipper must never mirror a deletion.** Today it does not — it clears only a
   session it is re-shipping, and a session that vanished from disk is never cleared
   and never re-inserted. That invariant is load-bearing and deserves an explicit
   test, because any future "sync"/"prune" feature would silently destroy the archive.
   memhouse is an accumulator, not a mirror.
3. **Shipping cadence is a data-loss question**, not a convenience one. A house whose
   shipper has not run inside the retention window has already lost sessions before
   memhouse ever saw them. Argues for the scheduled service being on by default and
   for `doctor` to say when the last successful ship was.

**Both moved out 2026-08-16** to a separate branch and a second agent — the shipper is
not MCP's file territory, and neither question blocks anything here. O1's outcome
changes which credential the installer should hand the shipper, so check where that
work stands before P6b ships.

The conclusion reached before they moved: the answer is **not** "tombstone the tail"
but "stop removing the tail". A shorter re-parse has two indistinguishable causes —
compaction (old tail is the only surviving copy) and a fixed adapter (old tail is
junk) — and today's clear destroys the first to tidy up the second. Design carried
over: bump a parse epoch in the sorting key on shrink, keep the old rows, insert-only.

---

## Risks

| Risk | Handling |
|---|---|
| hand-rolled protocol drifts from spec | `rpc.js` is the only file that can drift; P5 drives it with two real clients |
| an agent damages data through `sql` | the pilot's grants, not our parser. Ship the reader-role recipe and make `doctor` show the grants (P6b) |
| `sessions_v` is a saved query, not a table | arrives as a parenthesised SELECT from `rooms()` — never emit it as a bare name |
| `queries.js` snapshots env at require time | stamp `process.env` before the require; assert a stated-config-only run reaches the right house |
| `cmdSearch` interpolates its needle | bound param on the way into `queries.js` |
| someone asks for remote/team HTTP | OAuth 2.1 resource-server work — named in P6, not smuggled into it |

## Order

P0 ✅ → P1 → ~~P2~~ (cut) → P3 → P4 → **P5 (gate)** → P6 → P8.
P6b is parent-repo work, landable any time after P1 — `doctor` printing `SHOW GRANTS`
first, since it costs an hour and makes the whole grant model visible. O1 is parent-repo
work too, and should be settled before P6b's provisioning ships. P7 only if earned.
