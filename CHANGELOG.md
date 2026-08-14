# Changelog

Versions before 0.8.0 were beta-only. Beta installs of 0.7.x and earlier should
uninstall and reinstall — the 0.8.0 layout is new, and an in-place `update` +
migration path is planned work, not a promise the old versions can cash.

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
