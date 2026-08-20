# Changelog

Versions before 0.8.0 were beta-only. Beta installs of 0.7.x and earlier should
uninstall and reinstall — the 0.8.0 layout is new, and an in-place `update` +
migration path is planned work, not a promise the old versions can cash.

## 0.12.7 — 2026-08-20

- **A member fully owns their house — `GRANT ALL ON <db>.* … WITH GRANT OPTION`.** Invite
  and the admin install previously granted `ALL` plus only `SELECT` *with grant option*, so
  a member could share read but not hand on anything more, and making them a true owner took
  a manual `GRANT`. Now the single grant carries the option on everything: their database is
  theirs to do anything with, including granting any of it onward. `/mem:share` is unchanged
  — it still opens only a read-only `SELECT` window — this just stops boxing the owner into
  read-only sharing of their *own* house. Still scoped to their db and still no `CREATE USER`,
  so a member cannot mint accounts or reach another house. Both grant paths updated
  (programmatic `adminBootstrap` + the `--print-sql` template); verified a fresh member gets
  all 43 db privileges grantable. (Existing members already upgraded by hand are unaffected.)

## 0.12.6 — 2026-08-20

- **Members can see who else is on the ClickHouse.** New accounts (via `memhouse invite`
  and the admin install) now get `GRANT SHOW USERS ON *.* ` — read-only visibility of the
  user list (names only; no passwords, no data), so `/mem:users` can answer "every user on
  the server" and a member can find who to share with. It grants no read of anyone's rows;
  that still needs an explicit `/mem:share`. Best-effort, like the self-`ALTER USER` grant:
  an admin without access-management just skips it. Both grant paths carry it — the
  programmatic `adminBootstrap` and the `--print-sql` template. (Existing members are
  unaffected; grant them by hand: `GRANT SHOW USERS ON *.* TO <member>`.)
- **The plugin nudges you when the client is behind.** `/mem:status` (and, quietly,
  `/mem:hello`) now compare the installed `memhouse version` against the latest npm release
  and, on a real gap (a minor/major behind, or many patches), offer `memhouse update` —
  which upgrades the CLI and, since 0.12.5, refreshes the `/mem:*` plugin too. A patch or
  two behind is mentioned gently or not at all; the skills never run the update themselves.

## 0.12.5 — 2026-08-20

- **`memhouse update` now refreshes the Claude plugin too.** Before, update upgraded the
  package, the service unit, and the house, but left the installed `/mem:*` skills as
  whatever an earlier `plugins install` had copied — so the plugin drifted behind the CLI
  (and showed an old version). Update now re-copies the plugin into every Claude config dir
  that ALREADY has it (never installs it somewhere new), from the files just put on disk,
  and stamps the manifest with the freshly-installed version. It prints each dir refreshed
  and a `/reload-plugins` reminder. (Self-update note: because `update` runs the
  pre-upgrade code, this takes effect from the update AFTER the one that installs 0.12.5.)

## 0.12.4 — 2026-08-20

- **Inserts are compressed and byte-bounded — the shipper stops choking slow links.**
  Profiling a real house behind a Cloudflare tunnel showed the shipper's inserts taking up
  to 77s each, and the ProfileEvents were unambiguous: `NetworkReceiveElapsed = 76s`,
  full-text index build 0.8s, CPU 1.1s, disk 0.009s — the entire cost was **uploading a
  ~27 MB uncompressed JSON batch through the tunnel**, not ClickHouse. Two fixes: the
  shipper now (1) **gzip-compresses the request body** (`compression: { request: true }`) —
  measured 3.6–8× smaller on the wire — and (2) **caps each insert batch at ~4 MB as well
  as 2000 rows**, whichever comes first, so a handful of very wide messages can't build a
  giant single upload (`MEMHOUSE_BATCH_BYTES` overrides the ceiling). Reads were never the
  problem — server-side SELECTs are 20–70ms; the latency you feel over a tunnel is round
  trip, and `FINAL` (needed for ReplacingMergeTree correctness) adds ~40ms.

## 0.12.3 — 2026-08-20

- **`install` no longer blocks on the first ship — it ships in the background.** A fresh
  member's first ship loads the entire local backlog (a real invitee's was 558 sessions /
  170k rows / **224 seconds**), and the installer ran it synchronously and near-silently,
  so `install` looked hung for minutes after "config written". Now install finishes
  immediately and starts the shipper as a detached background daemon (the same one
  `memhouse start` runs), which loads the history and keeps shipping — `memhouse status`
  shows it fill in. It defers to an installed service rather than running a second shipper,
  skips if one is already running, and is started AFTER the invite password rotation from a
  re-read config so the daemon never holds the pre-rotation password. `--no-ship` still
  skips it. Both install paths (invite `--env` and direct `--url/--user`) and `onboard`
  (which calls install) are covered. Verified end to end: install returns in ~0s and the
  detached shipper comes up alive.

## 0.12.2 — 2026-08-20

- **The Claude plugin now reports the real version.** `plugin.json` carried a hardcoded
  `"version": "0.11.0"` in the source, copied verbatim on install — so the plugin
  advertised 0.11.0 no matter which memhouse produced it, disagreeing with
  `memhouse --version`. `plugins install` now stamps the installed manifest with the
  package version (the single source of truth), and the source manifest was bumped to
  match. Re-run `memhouse plugins install claude` to refresh an already-installed plugin.

## 0.12.1 — 2026-08-20

- **The skills no longer fall back to a hardcoded `mem` house.** A house is a database
  named for its owner — `resolveConfig` defaults `MEMHOUSE_DB` to the connection's
  username (`polat` ships into `polat.messages`), and `memhouse invite` mints a per-user
  database. But the plugin skills hardcoded `${MEMHOUSE_DB:-mem}` in their connection
  recipes, so a config missing `MEMHOUSE_DB` would silently query a `mem` house that the
  user-named convention had moved on from. All eight skills now fall back to
  `${MEMHOUSE_DB:-$MEMHOUSE_USER}`, matching the CLI. (The env file always sets
  `MEMHOUSE_DB`, so this only bit an unset-DB config — but the stale default was wrong.)

## 0.12.0 — 2026-08-20

- **`memhouse relocate --to <url>` moves a whole house to a new ClickHouse.** The copy is
  a server-to-server `remoteSecure()` INSERT SELECT — the destination pulls each room
  directly from the source over the native protocol, so the pilot's laptop is never in the
  data path and, crucially, **the shipper never re-ingests**: once the new host holds a
  faithful copy, the shipper's skip predicate sees every old session already present and
  ships only genuinely new work. Provenance is carried, not restamped
  (`insert_allow_materialized_columns=1`), so a shared house keeps every member's
  `user_id` — verified against two live ClickHouse instances (source rows stamped `alice`
  arrive as `alice`, not the copier). `house_meta` carries only durable facts
  (`schema_version`, `min_writer_schema`, `share:*`); per-host heartbeats regenerate. The
  SOURCE is only ever read — a failed run leaves the old house intact — and a hard
  row-count gate must pass before the local config is repointed (the previous env is kept
  as `env.pre-relocate`). Flags: `--to-user/--to-password/--to-db`, `--from-native-host`
  (when the destination's route to the source differs from the pilot's URL),
  `--from-native-port` (default 9440 TLS), `--insecure-native` (`remote()` + 9000),
  `--keep-shipper`, `--dry-run`, `--yes`. The source password reaches the destination's
  `query_log` (never this transcript) — rotate it after if those logs are not yours.
- This is the host-to-host data-copy piece named in
  `docs/design/host-repoint-reconciliation.md`; the reconciliation gate (detecting an
  *accidental* repoint at an empty host) remains deferred.

## 0.11.3 — 2026-08-20

- **Read a friend's shared memory by naming their house.** A share is a read-only GRANT on
  a whole house (a ClickHouse database), and the rooms resolve by the connection's
  database — so `/mem:ask`, `/mem:search` and `/mem:sql` now recognize a house named in the
  question ("how did yigit fix X", "search … in yigit", "query yigit's house"), resolve it
  against `SHOW DATABASES`, and point the connection at that house with your own
  credentials, read-only. A name that matches a readable house wins over the `in <project>`
  qualifier — otherwise "in yigit" silently filtered your own project column and returned
  nothing. `/mem:hello` now names the phrase, and `/mem:users` still lists the houses shared
  with you.

## 0.11.2 — 2026-08-20

- **`/mem:hello` leads with a what-is overview.** Before, the welcome skill only said
  what memhouse *is* in its not-configured branch — a configured user got session counts
  and a command tour but never the one-paragraph framing. It now gives a
  state-independent overview first, in every state: a shipper reads 17 editors' session
  files into a ClickHouse *house you own*, on any ClickHouse you point it at (local, your
  own VM, or a managed/remote server — memhouse is not a hosted service and phones nothing
  home), runs no LLM in its path, and outlives the transcripts editors delete after weeks.
- **The tour now separates the three retrieval skills.** `/mem:ask`, `/mem:search` and
  `/mem:sql` overlap enough that the same words work in each; the tour carries the rule
  that tells them apart — **want a session → search, want an answer → ask, want a number →
  sql** (ask runs a search then reads and cites; search stops at the list; sql aggregates).

## 0.11.1 — 2026-08-20

- **Upgrading from 0.9.x needs one manual step**, and the tool now says so plainly. `memhouse update` runs the OLD version's update code (it replaces itself mid-run), and 0.9.x predates migrations — so it cannot prompt to migrate the house the way an upgrade from 0.10+ does. The first ship after such an upgrade refuses (nothing is lost) and now leads with the exact fix: **run `memhouse migrate` once, by hand.** From 0.11 onward the interactive prompt works normally. (Found upgrading a real 87k-message house.)

## 0.11.0 — 2026-08-20

- **`memhouse invite <name>`** mints a member and their own house on the server (same
  verified path as the admin install — grants, grant option, async pin, connect-as-member
  proof) and writes the ONE env file their install needs; this machine's config is never
  touched. Refuses loopback URLs (the file must work from the invitee's machine) and
  states plainly that the file is a credential.
- **`memhouse install --env <file>`** installs from an invite file: values load as if
  typed, nothing prompts, nothing persists until the connection and rooms prove out.
- **`memhouse passwd`** rotates this member's password and rewrites the env file —
  admin-assisted by ClickHouse's rules (members deliberately hold no ALTER USER), and the
  reason it exists: an invited member's password is known to the inviter until rotated.
- **Self-service password rotation.** Members are granted `ALTER USER ON <self>` — a
  self-scoped grant (verified non-escalating: the holder cannot alter or grant on any
  other user), so `memhouse passwd` needs no admin. It tries self-rotation first and only
  falls back to `--admin-*` for a pre-0.11 member.
- **`memhouse invite` uses your own credential when it can.** If the configured user can
  manage users (an install made as an admin-capable ClickHouse user), no `--admin-*` is
  needed. The invite file carries `MEMHOUSE_INVITE=1`, and `memhouse install --env` then
  OFFERS to rotate the inviter-set password to one only the invitee knows (`--yes` does it
  unasked) — so the inviter's knowledge of the password expires at install.
- **`/mem:invite` and `/mem:hello`** — the invite flow and a grounded introduction from
  inside an agent. Inviting comes before sharing: a share can only grant a user who
  exists.

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
