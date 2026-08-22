# memhouse mcp — architecture sketch and a worked flow

Written 2026-08-16. Companion to `PLAN.md` and `SPEC-2026-07-28.md`. Wire shapes below
are copied from the spec pages, not from memory.

## Architecture

```
  Claude Desktop   Cursor   Copilot   Goose        Claude Code / browser
        │            │         │        │                    │
        └── stdio: one subprocess each ─┘          Streamable HTTP (P6)
                     │                                       │
                     ▼                                       ▼
        memhouse/mcp/stdio.js                    memhouse/server/server.js
        newline-delimited JSON-RPC               POST /mcp  ── headers:
        stdin → in, stdout → out                 Mcp-Method, Mcp-Name,
        stderr → all logging                     MCP-Protocol-Version
                     │                                       │
                     └───────────────┬───────────────────────┘
                                     ▼
                         memhouse/mcp/rpc.js          ← the only file that
      reads _meta (protocolVersion, clientCapabilities, clientInfo)
      writes _meta.serverInfo + resultType: "complete"
      serves server/discover, tools/list (ttlMs, cacheScope, stable order)
      maps errors: -32022 version, -32602 not-found, -32601 unknown method
                                     │              knows MCP exists
                                     ▼
                        memhouse/mcp/tools.js         ← 6 async functions.
      search · timeline · get_session · stats · resume_command · sql
      Plain args in, plain JSON out. Zero protocol knowledge. Unit-testable
      with no transport, no client, no spec.
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
   memhouse/server/queries.js                       memhouse/resume.js
   rooms(), getChat, rawQuery                       resumeFor()
   caps: rows/bytes/time/mem  ·  readonly=1         print-never-run
              │
              ▼
        @clickhouse/client  →  the house
        rooms: sessions_<m> · messages_<m> · tool_calls_<m> · sessions_v (saved query)
```

**What is deliberately absent** — each one is a failure class in the incumbent:

| Not built | Why |
|---|---|
| session store / `Mcp-Session-Id` | the 2026-07-28 protocol has no sessions |
| resident worker, port-per-user | claude-mem's process-leak class; must not be constructible |
| new daemon | HTTP mounts on the dashboard app that already runs |
| queue, retry framework, LLM | no writes, no inference — reads are one round trip |

**Per-process state is exactly two memoized values**, both in `queries.js`:
the ClickHouse client and the `rooms()` promise (one `currentUser()` round trip).
Neither is per-client, both are rebuildable from config. That is why an
unexpected exit costs nothing — the client respawns and retries.

## Flow — a stdio session end to end

### 0. Spawn

Client config runs `memhouse mcp`. `bin/memhouse.js case 'mcp'`:

```
resolveConfig()            flags → MEMHOUSE_* → $MEMHOUSE_HOME/env
requireConfig(cfg, 'mcp')  no house stated ⇒ do NOT guess localhost:8123
stamp process.env.MEMHOUSE_*   ← BEFORE the require; queries.js snapshots env
require('../memhouse/mcp/stdio')  → read loop on stdin
```

**No-house handling, decided here:** the process still starts and still answers
`server/discover` and `tools/list` — those need no house. A `tools/call` returns
a normal tool result with `isError: true` carrying the standard refusal and its
fix lines. Protocol errors are for protocol problems; a missing house is a tool
problem, and a client that cannot even list the tools shows the user nothing but
"server failed".

**stdout is protocol-only.** Framing is one JSON-RPC message per line, no embedded
newlines, and the spec is explicit: the server MUST NOT write anything to stdout
that is not a valid MCP message. All logging to stderr — clients MAY ignore it and
MUST NOT read it as failure. Our trap: `MEMHOUSE_DEBUG=1` un-silences the
ClickHouse driver (`queries.js:34`). Test that it lands on stderr.

### 1. `server/discover` (the client's first request, and our compat probe)

```json
{"jsonrpc":"2.0","id":"discover-1","method":"server/discover",
 "params":{"_meta":{
   "io.modelcontextprotocol/protocolVersion":"2026-07-28",
   "io.modelcontextprotocol/clientInfo":{"name":"ClaudeDesktop","version":"…"},
   "io.modelcontextprotocol/clientCapabilities":{}}}}
```

```json
{"jsonrpc":"2.0","id":"discover-1","result":{
  "resultType":"complete",
  "supportedVersions":["2026-07-28"],
  "capabilities":{"tools":{}},
  "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"memhouse","version":"0.9.0"}},
  "instructions":"Search this team's agent conversation memory across 17 editors. Call search first — it returns an ID index with the token cost of expanding each hit. Fetch full text with get_session only for the ids you chose.",
  "ttlMs":3600000,"cacheScope":"public"}}
```

`instructions` is the cheapest lever in the whole surface: it is the paragraph
every client puts in front of its model. Write it like a tool description, not a
README.

Wrong version in ⇒ `-32022` with `data.supported`, and the client retries. That is
the entire negotiation.

### 2. `tools/list`

Deterministic order (prompt-cache hits), and `CacheableResult` is required:

```json
{"jsonrpc":"2.0","id":2,"result":{
  "resultType":"complete",
  "tools":[{"name":"search","…":"…"},{"name":"timeline"},{"name":"get_session"},
           {"name":"stats"},{"name":"resume_command"},{"name":"sql"}],
  "ttlMs":86400000,"cacheScope":"private",
  "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"memhouse","version":"0.9.0"}}}}
```

`cacheScope: "private"` — the list is house-shaped, never for a shared
intermediary. Long `ttlMs`: our tool list changes on release, not on data.

### 3. `tools/call search` — the compact index

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"search","arguments":{"q":"clickhouse readonly settings","limit":10},
 "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}
```

Result rows, ~60 tokens each, no transcript text:

```json
{"session_id":"claude-code:0f1e…","user_id":"polat","source":"claude-code",
 "project":"memhouse","at":"2026-08-12 21:07","hits":14,
 "snippet":"the driver's ERROR-level dump lands ahead of every message…",
 "est_expand_tokens":18400}
```

`est_expand_tokens` is the differentiator. claude-mem *asserts* ~10x savings from
progressive disclosure; we hand the model the number and let it choose. Ten hits
listed ≈ 600 tokens; expanding all ten ≈ 180k. The model picks two.

### 4. `tools/call get_session` — the only tool that returns text

```json
{"name":"get_session","arguments":{"session_id":"claude-code:0f1e…","user_id":"polat","seq_from":120,"seq_to":180}}
```

Internal path, per call:

```
tools.js  → queries.js q()  → applyRooms({{messages}} → messages_polat)
          → bound params (never string interpolation — an MCP argument is
            attacker-shaped input in a way a CLI argument is not)
          → READ_SETTINGS + final:1
          → ClickHouse
```

For `sql`, one extra setting: `readonly=1`, pinned server-side per request, plus
exactly one memhouse-side rule: **table functions that reach off this ClickHouse are
refused before the query is sent** (`memhouse/server/sql-guard.js`, shared with the
dashboard's `/api/query`).

Everything else about what the query may touch is still the credential's grants,
enforced by ClickHouse and passed through verbatim — including reading a housemate's
shared database by name, which this tool must keep and the dashboard does not. The one
exception exists because the server stopped enforcing it: `memhouse relocate` pulls
over `remoteSecure()`, so every member is granted `REMOTE ON *.*`, and `remote()` now
runs happily under a pinned `readonly` — see the 2026-08-22 addendum in `GRANTS.md`
for the probe. A model writing SQL from transcripts it did not author is the caller
here, so the boundary has to be stated somewhere; it is stated in one file, tested
directly, rather than in a second parser beside the first.

### 5. `tools/call resume_command`

`resumeFor()` returns the paste-ready command or an honest refusal for an editor
whose flag has never been read from its own `--help`. Unchanged semantics: the
tool PRINTS, the pilot runs it. An MCP client must not be handed a "resume" that
silently starts a new session.

### 6. Shutdown

Client closes stdin; we exit on EOF. That is the only portable graceful signal,
and honoring it is what keeps clients from escalating to SIGKILL. Nothing to
flush — no session, no queue, no partial write anywhere.

## The same flow over HTTP (P6)

Identical, one hop earlier:

```
POST /mcp
Mcp-Method: tools/call
Mcp-Name: search
MCP-Protocol-Version: 2026-07-28
Content-Type: application/json
{ …same JSON-RPC body… }
```

`rpc.js` is unchanged; the express route unwraps headers and body and calls it.
Loopback-bound like the rest of the dashboard. There is no GET endpoint in this
revision — nothing to mount for server-initiated traffic, and we have none.

## Why the layering pays

`tools.js` never learns what MCP is. So: the beta-SDK risk is contained to
`rpc.js`; a fallback to 2025-11-25 stdio is a rewrite of one file; the CLI could
grow `memhouse timeline` over the same function tomorrow; and the tests that
matter (does `search` find it, does `sql` refuse `url()`, do credentials ever
appear in a result) run with no client, no transport, and no spec in scope.
