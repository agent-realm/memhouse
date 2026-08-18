# Changelog

Versions before 0.8.0 were beta-only. Beta installs of 0.7.x and earlier should
uninstall and reinstall — the 0.8.0 layout is new, and an in-place `update` +
migration path is planned work, not a promise the old versions can cash.

## Unreleased

**`memhouse mcp`.** The house over MCP: the Claude Code skills reach only Claude
Code; MCP reaches every client memhouse already parses — Claude Desktop, Cursor,
Windsurf, Copilot, Goose, and the rest read the same memory back.

- Six read-only tools: `search` (a compact index — every hit priced with
  `est_expand_tokens`, the cost of expanding that session, so the model chooses
  before it spends), `timeline`, `get_session` (the only tool returning transcript
  text; slices by `seq`; with two members holding the same session id it answers
  with the holder list instead of guessing), `stats`, `resume_command` (the same
  print-never-run contract as `memhouse resume`), and `sql` (free-form read-only).
- **No SQL parser.** `sql` pins `readonly` server-side and passes ClickHouse's own
  refusal through verbatim — what the credential may read is the operator's GRANT
  choice, enforced by the server, not by application code. Results are capped
  (10000 rows / 64MB / 30s) as self-protection, exactly like the dashboard's SQL
  console.
- Two transports, one protocol layer: stdio (`memhouse mcp`) and `POST /mcp`
  mounted on the running dashboard — same process, loopback, no new daemon. Both
  are dual-era: the stateless 2026-07-28 revision (per-request `_meta`,
  `server/discover`, `CacheableResult`, deterministic tool order) and the classic
  `initialize` handshake today's clients still open with.
- The HTTP mount validates `Origin` (403 for non-local pages), checks
  `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` against the body (`400` +
  `HeaderMismatch` on disagreement, base64 sentinel decoded first), answers
  unknown methods `404`/`-32601`, and ignores legacy `Mcp-Session-Id` /
  `Last-Event-ID` rather than honoring them.
- With no house configured the server still starts and lists its tools; each call
  refuses with the standard no-config message as a tool result. It never guesses
  `localhost:8123`, and the credential it does hold is scrubbed from every
  outgoing frame — including results that legitimately select it.
- Tested at three levels: protocol units in `npm test`, and two live batteries
  over a throwaway house (`misc/mcp-test.js` for stdio, `misc/mcp-http-test.js`
  for HTTP) — 57 checks total, including a real-client pass driven by Claude
  Code itself via `--mcp-config`.

## 0.9.0 — 2026-08-16

**`node:sqlite`.** Breaking on the Node floor, and the reason `npm i -g memhouse` is
now the whole install.

- The `better-sqlite3` dependency is **gone**, replaced by `node:sqlite` — built into
  Node, stable in 24. No native binding, no install script, no build step.
- **`--allow-scripts=better-sqlite3` is retired.** It was required on every install and
  every upgrade, npm never remembered it, and omitting it left cursor, zed, opencode,
  goose and antigravity reading zero sessions — indistinguishable from editors the
  pilot does not have. That failure class no longer exists, so the probe that reported
  it (`MISSING_BINDING`, `probeSqlite`) and the `missingBinding` flag on every
  `getAdapterErrors()` entry are removed. Per-store failures — locking, permissions,
  corruption, schema drift — are reported exactly as before.
- **`engines` moves to `>=24`.** `node:sqlite` works flagless on 22.13+ but prints
  `ExperimentalWarning` on every command (measured on v22.23.2); Node 20 is past EOL.
- Blob columns arrive as `Uint8Array` rather than `Buffer`, whose `toString()` renders
  byte values instead of decoding utf-8. Every blob-or-text read in the adapters now
  goes through `editors/sqlite.js`; message output was verified byte-identical against
  the old implementation on real opencode and zed stores and on BLOB-valued cursor and
  goose fixtures.

## 0.8.0 — 2026-08-14

**The shared house.** Breaking, and the reason the number moved.

- A **house is a ClickHouse database**; its rooms are three plain shared tables —
  `sessions`, `messages`, `tool_calls`. Everyone in the house writes into the same
  tables with their own credential. `FROM messages` just works.
- **Provenance is two columns no client can fake**: `user_id` (server-stamped
  `MATERIALIZED currentUser()`, with `async_insert = 0 CONST` pinned on the user so the
  stamp cannot be skipped) and `host` (a random fingerprint minted once per install).
- **Joining any ClickHouse is two statements**: `CREATE USER` + `GRANT ALL ON <house>.*`.
  The member's own shipper creates and evolves the rooms.
- The house name defaults to the username (`polat` ships to `polat.messages`) and is
  freely decoupled (`--db`); `system` and `information_schema` are refused everywhere —
  previously `--db system` granted a member everything on the server's own database.
- Removed: per-member suffixed rooms, Merge rooms, the narrowed grant set,
  `provision.js`, `--adopt-user`. Housemates are collaborators; groups that should not
  see each other get separate houses.
- Field-tested: two physical machines shipping as one member into one house, split
  cleanly by `host`; rootless-podman `deploy --local`; ClickHouse 25.11 and 26.7.

## 0.7.x — 2026-08-13

- **0.7.1**: the shared settings profile detached every previously-assigned member on
  each provision (only the last member ever had resource ceilings, since 0.4.7) — fixed,
  then removed entirely in favour of a single per-user pin. `async_insert = 0 CONST`
  guards the identity stamp server-side. `install` no longer reports a user it just
  created as "already exists".
- **0.7.0**: `uninstall` became three tiers (default keeps config and identity;
  `--credentials`; `--full-removal`, which asks). Host identity became a random
  per-install fingerprint — the old derived id collided across same-hostname machines
  and split on rename.

## 0.6.0 — 2026-08-13

- Deleted every path that existed only for versions nobody ran: the inherited
  agentlytics server/cache/relay stack (~4,800 lines), four dependencies, the second
  installer, and the solo-tier/pre-0.4 compatibility branches.

## 0.5.0 — 2026-08-12

- `memhouse resume <session-id>` — prints the command that reopens a session in its own
  editor (claude, codex, opencode verified from their own `--help`; GUI editors and
  unverified CLIs refuse, each with the honest reason).
- `memhouse update` — re-passes the install flag, restarts daemons, checks the schema.
- Daemons detect their own upgrade and hand over (exit under a supervisor, re-exec
  otherwise).
- `plugins install claude` acts on every Claude Code config dir on the machine;
  `onboard` finally offers the skills.

## 0.4.x — 2026-07-31 → 2026-08-12

- Per-member rooms as the only layout (later superseded by 0.8.0's shared house).
- The `origin` guarantee: imported history survives re-ships — `origin` in the
  messages/tool_calls sorting keys and bound in the shipper's clear. The bug this fixed
  destroyed 27,948 imported messages in a single pass.
- Local house delivery (`deploy --local`, docker/podman), OS service integration,
  the herdr-driven acceptance suite, `memhouse.io`.

## 0.3.x — 2026-07-22 → 2026-07-31

- First real releases: the 17-adapter shipper, typed ClickHouse schema, CLI, dashboard,
  Claude Code skills, npm publication. Sixteen adversarial review rounds hardened the
  adapter layer's failure reporting — a failed read writes nothing, and every silent
  swallow found was one layer behind the last.
