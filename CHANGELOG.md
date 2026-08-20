# Changelog

Versions before 0.8.0 were beta-only. Beta installs of 0.7.x and earlier should
uninstall and reinstall — the 0.8.0 layout is new, and an in-place `update` +
migration path is planned work, not a promise the old versions can cash.

## 0.10.0 — 2026-08-20

**The shipper stops deleting.** Breaking on the room schema: an existing house needs
`memhouse migrate-rooms` before it can be shipped into.

- **`DELETE FROM` is gone from the shipper**, and with it the only privilege whose misuse
  loses data — nothing memhouse runs needs `ALTER DELETE` any more. The clear existed to
  remove the stale `seq` tail a shorter re-parse leaves behind (ReplacingMergeTree dedupes
  same-key rows; it cannot remove a row the new parse no longer produces). It could not
  tell a fixed adapter bug from a **compacted or expired transcript** — Claude Code
  rewrites sessions in place and deletes them after `cleanupPeriodDays`, 30 days by
  default — so it destroyed content the house was the last copy of.
- **`epoch` joins `origin` in the sorting key** of `messages` and `tool_calls`. A re-parse
  that is shorter than the stored one, or that differs from it at a `seq` the house already
  holds (compared on the stored `line_hash`), is written under a new epoch; the superseded
  parse stays complete and readable. An unchanged or merely longer re-parse reuses its
  epoch and dedupes exactly as before, so the common case costs nothing.
- **Reads show one parse per session.** `roomNames()` resolves `messages` and `tool_calls`
  to a current-epoch subquery, and the bare tables only as `messages_raw` /
  `tool_calls_raw` for writes and DDL. Counts, tokens and cost are unchanged. Hand-written
  SQL needs the filter — `/mem:sql` carries it.
- **`memhouse migrate`** — a migration runner, not a one-off. Migrations live in
  `memhouse/house/migrations/<id>.js` (registry: id, component, toVersion, detect, plan,
  steps); the runner detects what a house still needs FROM ITS ROOMS (never from the
  record — a hand-migrated house has no record), shows the plan, and executes in order.
  `--dry-run` prints and touches nothing; `--yes` skips the confirm. Every migration
  inherits the invariants: nothing deleted, provenance never restamped, atomic swap,
  late writes survive, everything recorded in `house_events`. `memhouse migrate-rooms`
  is the same runner scoped to the rooms component.
- **`memhouse update` names, asks, or runs pending migrations.** After the files update
  it detects what the house needs: `--migrate` (or `--yes`) runs them unasked,
  an interactive session is asked once (the inner confirm is not repeated), and a
  non-interactive run only names them and prints the command — a cron must never start
  a house-wide copy on its own. `update --no-install` skips the npm/git step for pilots
  who already upgraded by hand and want the half a bare `npm i -g` leaves undone.
- **`memhouse uninstall` asks first.** It used to start removing the service the moment
  it was typed. It now prints exactly what the chosen tier removes and keeps (the house
  data is never touched, and says so), confirms once, takes `--yes` for scripts, and a
  non-interactive run without `--yes` refuses rather than proceeding.
- **`memhouse nightly [--out DIR]`** builds an installable, version-stamped tarball from
  a checkout (`<base>-nightly.<YYYYMMDDTHHMM>`) without publishing — stamp, `npm pack`,
  restore, so the checkout stays clean and the test machine's `--version` tells the
  truth. On such an install use `memhouse update --no-install`; plain `update` installs
  `memhouse@latest` and silently downgrades a nightly.
- **`/mem:share` and `/mem:users`** — sharing as a skill. Members are now granted
  `SELECT … WITH GRANT OPTION` beside their `ALL` (both install paths), so
  `/mem:share <user>` opens a read-only window into your own house with no operator —
  and can hand on nothing more, because the grant option stops at SELECT. `revoke` closes
  it; bare `/mem:share` lists who can read you. On a pre-0.10 house (no grant option) the
  skill prints the one statement the admin runs. `/mem:users` reports who writes into
  your house, whose houses you can read, who can read yours, and (where permitted) the
  server's user list — each section degrading legibly on a hardened server.
- **`/mem:status`** reports the memory system's state from inside an agent: per-editor
  holdings (current parses only), freshness and coverage bounds, schema generation and
  migration state, and the writer fleet — including the rows-without-record signature of
  a pre-0.10 machine still writing.
- **The plugin is `mem` now, and it answers questions.** Skills install as `/mem:ask`,
  `/mem:search`, `/mem:sessions`, `/mem:sql` (the `mem` short name belonged to the
  retired memory-house and moves to the living product). `/mem:ask` is new: retrieve the
  relevant past sessions, read the transcripts, answer with citations — the synthesis is
  the agent's; memhouse itself still runs no LLM anywhere. The installer removes a
  pre-0.10 `skills/memhouse/` copy (only when it is provably ours) so the old and new
  namespaces never load side by side.
- **`install` ends with a getting-started overview** — dashboard, service, skills,
  search, doctor — instead of a single next-step line.
- **Writer compatibility is enforced, both directions.** Each release declares which
  schema generations it may write (`SUPPORTED_SCHEMAS`); every pass starts by reading the
  house's own record and refuses — before touching a room — when the house is newer than
  the shipper (`Update THIS machine: memhouse update`) or below the floor a migration set
  (`house_meta['min_writer_schema']`). The room-shape checks stay: they catch what a
  record cannot (a hand-built house with no record at all).
- **The house knows its fleet.** Every writer records the schema it supports and a
  per-pass heartbeat, keyed `member@host` (member-only keying let two machines of one
  member clobber each other's entry). `memhouse status` shows the fleet — writer,
  version, last ship — and `doctor` fails on the writers that matter: `legacy` (a
  pre-0.10 memhouse, visible because its ROWS are in the house while it records nothing
  about itself — its re-ships delete retained parses) and `outdated` (refusing every
  pass until updated). Ground truth is the data, not the record, so a writer that
  predates the record cannot hide.
- **Mixed-version fleets: upgrade every machine of a member promptly.** A pre-0.10
  shipper on another machine keeps working against migrated rooms (its key check only
  looks for `origin`), but its delete-before-reinsert reaches every retained parse of a
  session it re-ships. `memhouse migrate` warns about this at migration time.
- **`memhouse migrate-rooms`** rebuilds rooms whose sorting key predates this version:
  copy, one atomic `RENAME`, old room kept as `<room>_pre_epoch` for the pilot to drop.
  Nothing is deleted, and `user_id` is carried across explicitly rather than restamped —
  it is `MATERIALIZED currentUser()`, so a plain `INSERT SELECT` would reassign every row
  in a shared house to whoever ran the migration. Rows a running shipper writes during the
  copy are picked up afterwards.
- **The house keeps a record of itself**: `house_meta` (schema version, per-member client
  version) and the append-only `house_events` (migrations pending/applied/failed, version
  changes, actor, host, row counts). `memhouse doctor` reads it back, so a migration that
  died between the copy and the swap is reported rather than left to be noticed.
- **Fixed: the schema column healer had been dead** since the rooms became plain shared
  tables. It matched `<type>_{{MEMBER}}`, which no longer exists, so it compared zero
  columns — while `ensureSchema`, `--ensure-schema`, `warnMissingColumns` and `doctor` all
  reported success over that empty comparison.
- `npm run test:house` — the first tests that run against a real ClickHouse (throwaway
  container, fixture adapters). Green on 25.11 and 26.7.

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
