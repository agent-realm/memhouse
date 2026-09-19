# Changelog

Versions before 0.8.0 were beta-only. Beta installs of 0.7.x and earlier should
uninstall and reinstall — the 0.8.0 layout is new, and an in-place `update` +
migration path is planned work, not a promise the old versions can cash.

## Unreleased

- **A machine keeps its host identity across reinstalls.** The fingerprint was
  `randomBytes(16)` living only in `host.json`, so wiping `MEMHOUSE_HOME` — an
  `uninstall --full-removal`, a reset, a re-imaged laptop — brought the same physical
  machine back as a stranger: one MacBook read as three writers in the fleet list, each
  holding a slice of one machine's history, and none of them removable without deleting
  rows. It is now derived from the machine's own id (IOPlatformUUID, `/etc/machine-id`,
  MachineGuid) hashed with a fixed salt, so the raw id never leaves the machine and cannot
  be recovered from a row; where none can be read it still falls back to random. An
  existing `host.json` always wins, so no install in the field changes identity.

## 0.18.5 — 2026-09-18

The first release on **one line**: published to `latest` and `team` alike. zeo was converted to the one layout the same evening with `memhouse convert` (six members, every row count identical before and after, shares carried).

- **One release line.** With zeo converted to the one layout there is no 0.17 line to keep:
  `latest` now points at the same 0.18.x build as `team` (kept as an alias), the publish
  guard and `AGENTS.md` say so, and `release/0.17` is retired.

- **`memhouse convert` — an operator moves a pre-one-layout house to the one layout.**
  Before 0.18 each member owned a database (`polat.messages`, `ALL ON polat.*`). `convert`
  finds every such member, renames their five rooms into `mem.<name>_*` in one atomic
  statement (nothing copied), swaps the database-wide grant for the one wildcard, carries
  whole-house shares and row policies to the new names, drops the 0.17.1 refreshable
  views (the shipper fills stats in the one layout), records an event in the member's
  events room, and drops the emptied database. `--dry-run`/`--print-sql` show the plan;
  `--guides --out DIR` renders `MEMHOUSE-UPGRADE-<member>.md` per member.
- **A member's env repairs itself after the move.** `memhouse update` and the shipper's
  startup both notice that `<db>.messages` is gone and `mem.<name>_messages` exists, and
  rewrite `MEMHOUSE_DB=mem`; `doctor` names it. So the member's whole upgrade is one
  command. Rehearsed by `misc/convert-matrix.sh`: a real 0.17.1-built house on 26.7,
  converted, shares intact, isolation intact, the member's old env adopted, 24/24.

## 0.18.4 — 2026-09-17

On the `team` channel. Found by the operator's own second machine on its first `update`.

- **`memhouse update` never crosses release lines on its own.** An unpinned 0.18.2 whose
  `team` tag had moved to 0.18.3 matched no tag, and the picker fell back to `latest` —
  zeo's 0.17.1, a different house layout. A real member was downgraded on her first update.
  The picker now follows the tag on the install's own major.minor line, and when no tag is
  on that line, or the registry does not answer, it stops and says so; `--channel` is the
  only way across.
- **`install --env` keeps the invite's channel, editors and roots.** The hoist copied only
  URL/USER/PASSWORD/DB, so a joined env had no `MEMHOUSE_CHANNEL` even though the invite
  carried one. The invite matrix asserts the joined env keeps it.

## 0.18.3 — 2026-09-17

On the `team` channel.

- **Folded subagent turns say which subagent they came from.** Claude Code forks
  (`<session>/subagents/agent-<id>.jsonl`) were folded into the parent with only a
  `[subagent]` tag, so one fork's transcript could not be isolated or cited, and an agent
  looking for the fork as its own session concluded it was never shipped. Each folded turn
  now carries `extra.agent.{id, description, type, turn}` — the description is what the
  parent's `Agent` call asked for, joined through the tool result that names the agentId.
  A fork the parent never named — a Workflow-run agent, or an older parent — is described
  by its own first prompt. `extra` is not part of the line hash, so nothing already shipped
  is re-shipped; rows from before this carry `{}` until their session ships again (or
  `memhouse ship --full`). The plugin reference and `/mem:recall` say how to read a fork.
- **Workflow-run agents ship.** Agents spawned by the Workflow tool live one level deeper,
  `<session>/subagents/workflows/wf_<id>/agent-<id>.jsonl`, and the fold never looked
  there: on two real playbooks, 99 of 164 forks had never reached the house. They fold like
  the rest, with `extra.agent.workflow` naming the run. Sessions with them ship a new epoch
  on their next pass (their text changes); the journal and meta files are not transcripts.

- **Bare `memhouse` beside an invite offers to process it.** With an `invite-<name>.env` in
  the current directory, `memhouse` with no command reads what it promises — house, member,
  server, without the password — and asks whether to join, instead of printing help. `--yes`
  joins unattended; a house already configured is only replaced on an explicit yes. It
  scans the current directory only, never `~/Downloads`, so invitations to other houses do
  not surface or auto-join by accident. With no invite present, the help screen as before.

- **A playbook is bound to the instance that installed its plugin.** `plugins install
  claude` from an instance that ships specific playbooks installs into exactly those, and
  stamps `MEMHOUSE_HOME` and `MEMHOUSE_BIN` into each playbook's `settings.json` `env`, so
  every session under it reads that instance's house and runs that instance's binary
  rather than whatever the shell inherited. The skills say so in their reference and use
  `${MEMHOUSE_BIN:-memhouse}`. `plugins list` shows the binding, `plugins remove` removes
  it, and nothing else in `settings.json` is touched.

- **The dashboard reads precomputed rollups.** Every dashboard aggregate used to rebuild
  the session rollup — `<member>_sessions FINAL` joined to the current parse of
  `<member>_messages`, 23 aggregate expressions, grouped over the whole house — on every
  query, and the cost, model and tool queries scanned the message and tool rooms on top.
  On a 714k-message house one such query read 1.4M rows and held 117 MiB; a page load was
  4–10 seconds. Three tables per member now hold the rollups —
  `<member>_session_stats`, `<member>_session_model_stats`, `<member>_session_tool_stats`
  — and the dashboard reads those (a few thousand rows). A page load is ~250 ms.
  **Filled by the shipper at the end of every pass, not by a materialized view:** a
  refreshable view swaps its target through a temporary table and needs
  `CREATE TABLE … ON <db>.*`, the database-wide grant this layout exists to withhold
  (measured on 25.8). Each refresh is a complete snapshot stamped with one `refreshed_at`;
  reads take the newest generation; a one-day TTL retires the rest. Created by `ship
  --ensure-schema` under the member's own `<db>.<member>_*` grant — so `memhouse install`
  and `memhouse update` both do it, and a house without them (or with empty, not yet
  refreshed ones) falls back to the inline rollup — slow, never wrong.
- **Every endpoint issues its reads in one round trip.** `/api/dashboard-stats` awaited
  nine queries in sequence; two thirds of what the browser waited for was network.
- **`/api/chats` prices the page, not the house.** The cost query priced all sessions to
  decorate fifty.
- Two latent ordering bugs fixed: the session list's `ORDER BY` was not a total order
  (paginated pages could repeat or skip a row on a timestamp tie), and top-N cuts resolved
  count ties by arrival order. Both tiebreak deterministically now.

## 0.18.2 — 2026-09-11

On the `team` channel. Two bugs found by a two-member arrival drill on 0.18.1, plus what
the drill taught:

- **The shipper spawned by `install --env` now holds the rotated password.** It held the
  invite's, which the rotation had just killed, and failed every pass with
  "Authentication failed" while every CLI command worked. The shipper also adopts a newer
  env-file credential on an auth failure instead of backing off on a dead one.
- **`status` and `doctor` read the shipper log's last pass.** A daemon failing every pass
  was "running" by pid and green in doctor. Now: `running — but the last pass FAILED — <why>
  — restart it: memhouse stop && memhouse start`, and a `✗` in doctor.
- The invitation guide says what to do when an agent's `npm install -g` is blocked by a
  permission classifier: the person runs step 1, the agent continues from step 2.
- `drills/DRILLBOOK-team-arrival-2026-09-10.md` and the drill record.

## 0.18.1 — 2026-09-08

On the `team` channel. Everything since 0.18.0, none of it reaching `latest` (0.17.0):

- `memhouse instance` — which memhouse this is on one screen; `/mem:house` opens with it.
- Playbook binding — `plugins install` stamps `MEMHOUSE_HOME`/`MEMHOUSE_BIN` into the
  playbooks an instance ships, so their skills read that instance's house and binary.
- Bare `memhouse` beside an `invite-<name>.env` offers to join; `--yes` joins unattended.
  The invitation guide points the invitee, or their agent, at the sibling credential file.

## 0.18.0 — 2026-09-08

Published on the `team` channel (`npm install -g memhouse@team`). `latest` stays 0.17.0:
this release speaks one room layout, and a house from before it is refused with the renames
that convert it rather than written into. Everything below is that layout and what it made
possible.

- **`memhouse update` follows the channel the install came from.** It used to install
  `memhouse@latest` unconditionally, which would have downgraded a house running a build
  published under another dist-tag, and replaced a tarball install with whatever latest
  was. Now the channel is pinned (`MEMHOUSE_CHANNEL`, or `--channel`, which writes it) or
  inferred from the installed version's tag; a version on no tag gets no automatic update
  and is told why. An invite from a house on a channel carries it into the invitee's env
  file, and the invitation guide says `npm install -g memhouse@<channel>`.

- **`invite` writes `MEMHOUSE-INVITATION.md` beside the credential.** The invitee gets two
  files: the one-time `.env`, and a guide with nothing secret in it — install, join,
  verify, what they own and who can see it, things to try, which sessions ship, and what
  the two refusals they might meet mean. Rendered rather than linked because it names
  their file, this house, and (until the build is on npm) the tarball to install. The
  matrix asserts the guide exists, names their rooms, carries no password, and has no
  unrendered placeholder.

- **The bookkeeping rooms are `<member>_meta` and `<member>_events`.** They were
  `<member>_house_meta` / `<member>_house_events`, a name from when the house was the unit
  of ownership. Every row in them is about one member — their schema version, their
  machines, their last ship, their shares — so the old prefix named the wrong unit. A
  house from before the one-layout still holds `house_meta` / `house_events`, and the
  shipper's legacy guard names that rename alongside the other three.

- **Choose which sessions ship.** `MEMHOUSE_EDITORS` names the adapters to run, and
  `MEMHOUSE_<EDITOR>_ROOTS` moves one adapter's location — `MEMHOUSE_CLAUDE_ROOTS` for
  the Claude Code config directories, `MEMHOUSE_CODEX_ROOTS` for Codex's home, one per
  adapter, named from the adapter. A machine with several Claude Code instances can ship
  one of them into a team house and leave the rest alone. `memhouse discover` prints what
  every adapter is watching and the variable that changes it. A name or directory that
  does not exist is refused against that adapter, never shipped from the default instead.

- **One layout.** Every member's rooms are named for them — `mem.polat_messages`,
  `mem.alice_messages` — and one grant covers them: `GRANT … ON mem.<name>_* TO <name>
  WITH GRANT OPTION`. A wildcard on the member's own name, verified on 25.11 and 26.7: it
  lets the member create and rebuild their own rooms and share them, and reaches nothing
  else — not a housemate's rooms to read, list, drop or re-grant. Nobody is granted the
  database. A house with one member is a house of one, not a different kind of house.

  This replaces the two layouts of the previous unreleased work (a house per member with
  `ALL ON db.*`, and a prefixed variant beside it) together with everything that existed
  to keep them apart: the one-owner invariant, the fencing step, `--shared-db`,
  `--table-prefix`, `MEMHOUSE_TABLE_PREFIX`, the operator creating rooms at invite, and a
  layout branch in eight code sites and nine documents. The database name is `mem` unless
  somebody has a reason; `--db` remains for that reason.

- **One provisioning plan.** `memhouse/provision.js` is the only description of what a
  member is granted. The live path executes it, `--print-sql` renders it, the unit tests
  assert on it. Three copies of this used to exist and had drifted — the printed one
  handed a non-admin the configuration the live path refused.

- **Standalone is a team of one.** `deploy --local` creates the container with an admin
  credential (`memhouse_root`) and a member named after your OS user, keeps both in
  `~/.memhouse/env`, and ships as the member. `invite`, `members` and `whoami --admin`
  use the admin credential from the file, so a house you deployed needs no `--admin-*`
  flags. A volume from before this release was initialised with the member as superuser
  and is reused as it is.

- **Houses from before this layout are refused, loudly.** A shipper that finds plain rooms
  (`messages`, not `<name>_messages`) stops and prints the five `RENAME TABLE` statements
  that move them across — instant, nothing copied — rather than creating an empty second
  set beside them and hiding every past session. Conversion of an existing house is a
  rename plus one grant swap; `doctor --fix` for that is the next change, not this one.

- `memhouse members` reads wildcard grants on servers without the `is_wildcard` column
  (25.11, the default local tag).

- **Bringing a housemate into a house you already own now works, and moves nothing.** A
  member alone in their own database holds `ALL ON polat.*`. That grant is **dynamic** —
  it covers rooms created later — so a housemate's rooms would be readable *and
  droppable* by the owner the moment they existed (both measured). `invite` used to
  refuse and point at a migration command that did not exist.

  It now **fences** the sitting owner instead: a `REVOKE` plus one `GRANT` per room they
  already have. Their rooms keep their names, their data does not move, there is no
  rename, no copy, no re-ship and no downtime — and an admin credential still reads the
  whole house, which is what an operator has.

  The order is REVOKE-then-GRANT, which is the opposite of what looks safe and the only
  one that works: `REVOKE ALL ON db.*` covers every table beneath it, so per-room grants
  issued first are wiped by it. Doing it the intuitive way locked a member out of their
  own memory — caught on a real server, now a test.

- Reading across members is `UNION ALL` over the rooms you hold, not a `merge()` pattern.
  The anchored pattern the README carried (`'^.*_messages$'`) silently dropped the house
  owner's own rooms, which are unprefixed — the one person most likely to run a team
  query saw everyone's memory except their own.

- **`share --only project=x` granted every project, then failed to scope.** The worst
  defect in this branch, and it was reachable by any member of a shared house. `share`
  granted `SELECT` on all rooms first and built the row-policy filters second; the
  prefixed layout never granted the row-policy rights (`ALL ON db.*` carries them, an
  explicit per-table list does not), so the scoping step could not succeed at all. A
  member asking to share ONE project handed over ALL of them, and `share --list` then
  reported "nobody has been granted a read" — the bookkeeping write happens after the step
  that failed.

  Now the filters are built BEFORE anything is granted, a failure drops what it built and
  grants nothing, and members hold `CREATE/ALTER/DROP/SHOW ROW POLICY` on their own rooms.
  The matrix asserts both halves — that a scoped share exposes only the named project, and
  that a scoping failure leaves the grantee with exactly what they had before.

  Found in a drill: an agent asked to open one project to a colleague, which no matrix
  did because every matrix shares whole rooms.

- **`invite --print-sql` printed the configuration the live path refuses.** It ignored
  `--shared-db` and `--table-prefix` entirely and emitted unprefixed shared rooms plus
  `GRANT ALL ON db.* TO <member> WITH GRANT OPTION` — the shape that lets any member read
  a housemate's rows and grant them to an outsider. The help routes non-admins to exactly
  this path ("Not an admin? `--print-sql` gives the statements to hand to whoever is"), so
  the one person who could not check the result was handed the leak, confidently, at exit
  0. It now honours the prefix, emits per-room grants and no database-wide grant, and the
  matrix RUNS the printed SQL and asserts it isolates identically to the live path.

  Found by a drill — an agent given an admin credential, a database, and two colleagues to
  set up, which is the only instrument that reads the output instead of the code.

- **`memhouse members`** — who is in a house, and what each of them reaches. Before shared
  houses a database had exactly one member and the question did not exist; this layout
  creates it, and the operator had no supported way to answer it. Warns when one account
  holds the whole database while others hold rooms in it — memhouse cannot create that
  shape, but a hand-written `GRANT` can.

- Help fixes the same drill turned up: the `--shared-db` block had been spliced through the
  middle of the sentence "write the env **file their install needs**", and four lines
  describing `install` were hanging under `passwd`.

- `invite` no longer prints "5 room(s) already exist and are not yours to create" while
  verifying a member it provisioned seconds earlier. It reads as a name collision on a
  database that was empty a moment ago, and sent one operator to `system.tables` to find
  out what had gone wrong. Nothing had.

- **Two members can no longer share one database with a grant each — it leaked.** Until
  now `invite bob --db alices-house --adopt` put both in one database with `ALL ON db.*`
  apiece, and the README taught it as the way to run a team. Measured on a real server:
  alice runs `GRANT SELECT ON team.* TO carol` and carol reads **bob's** messages. No
  admin involved, nothing written to any log, bob never told.

  `invite` now enforces one invariant: **a database is one member's house, or it holds
  per-member rooms — never both, and never two database-wide owners.** `--adopt` does not
  override it; that flag now means what it was needed for, taking over your *own* house
  with a new credential. Inviting a second member into an occupied database points at
  `--shared-db` instead.

  A team dashboard does not need the removed shape. `merge(mem, '^.*_messages$')` reads
  every room in one query and is filtered by grant: the operator sees all of them, a
  member sees only their own from the identical query, and a member who joins tomorrow
  stays invisible until someone grants their room. Aggregate visibility became opt-in.

- **`memhouse invite --shared-db <db>` — one database, a room set per member.** Until now
  a member meant a database: `alice.messages`. On a ClickHouse where that is not wanted,
  `--shared-db mem` puts everyone in one database under their own names —
  `mem.alice_messages`, `mem.bob_messages` — and grants each member only their own three
  rooms, one statement per table because ClickHouse rejects `ON db.a, db.b` outright
  ("Syntax error … Expected access type").

  It exists for a reason that is social rather than technical: **a grant is something a
  colleague can verify and a row policy is not.** Alice runs `SHOW GRANTS FOR alice`, sees
  her three tables, and `SHOW TABLES FROM mem` does not even list the rooms she was not
  granted — measured, she cannot read, drop, or enumerate a housemate's rooms, and cannot
  create tables beside them. Nothing has to be taken on trust.

  The **operator** creates the rooms, during `invite`, while an admin credential is in
  hand. If the member created them she would need `CREATE TABLE` on the whole database —
  enough to add tables beside everyone else's, which is the blast radius this layout
  removes. `CREATE TABLE IF NOT EXISTS` is checked against the grant *before* existence,
  so `ensure-schema` skips what it may not do and continues, which it already knew how to.

  Members hold `WITH GRANT OPTION` on their own rooms and nothing else, so `memhouse share`
  still works without an operator and still cannot reach a housemate's rows. Sharing,
  revoking and the `--only` row policies all target the member's own rooms.

  `MEMHOUSE_TABLE_PREFIX` carries it, written by `invite` into the env file, so the
  invitee picks nothing. Empty means the layout memhouse has always had — verified byte
  for byte against the previous resolution.

- **`memhouse rooms`** — what your rooms are actually called. Boring in your own house
  (`messages`); the only way to know in a shared one (`mem.alice_messages`). It resolves
  through the same function the shipper writes with, so it cannot drift from the server.

- **The `/mem:*` skills work in a shared house.** They write `FROM messages` bare in some
  fourteen places, which names nothing in a house holding `alice_messages`. Rather than
  teach fourteen query sites about prefixes, the `q()` helper in `reference/HOUSE.md` —
  the single connection every skill routes through — now rewrites room names after
  `FROM`/`JOIN`. A needle like `LIKE '%messages%'` is untouched, and `FROM yigit_messages`
  is left alone so a shared room still reads.

  Written with `[[:space:]]` classes, not `\b`: **BSD `sed` does not support `\b`**, and
  the first version matched nothing on macOS. `misc/prefix-skill-recipe.sh` extracts
  `q()` from the reference and runs it against both layouts — the doc is executable
  because it is load-bearing.

## 0.17.0 — 2026-08-25

- **`memhouse share` — partial sharing, by row policy.** A share used to be all or
  nothing: `GRANT SELECT` on the whole house, every project and machine and anything ever
  pasted into a session. Now `memhouse share <user> --only project=memhouse` (or
  `session=`, `folder=`, `host=`, `source=`, `since=`, `until=`, combined with commas)
  scopes it with a row policy per room. `--list` shows who reads what, `--revoke`
  withdraws.

  It is a command rather than SQL in a skill because partial sharing has four quiet
  failure modes. A permissive catch-all policy for everyone else is the obvious design and
  **fails open** — measured, a second scoped user saw all 22,500 rows instead of their
  1,860, because policies are OR'd. ClickHouse answers this properly through
  `users_without_row_policies_can_read_rows`, but that is server config with a default
  that has moved between versions, so the command *measures* the behaviour on a scratch
  table before creating the first policy and refuses on a server that would blindfold the
  readers you already have. Revoking now drops the policies — leaving them made a later
  re-share silently reinherit the old scope. Widening a scoped share to a full one clears
  them and says so. All three rooms move together or the share leaks, and `sessions` is
  scoped on `created_at` because it has no `ts`.

  `memhouse share --list` also reports policies pointing at a table that no longer exists:
  dropping a table or a house leaves its policies behind, and one recreated under the same
  name silently inherits them.

- **The `/mem:*` skillset is five skills and one shared reference, down from ten.** Four
  of the ten had to explain in their own descriptions why they were not their siblings
  (`/mem:ask`: *"this is the retrieve-and-answer skill; /mem:search is find-the-session"*),
  which is what a wrong boundary looks like — an agent asked "what did I decide about X"
  had to choose between `ask`, `search`, `sessions` and `sql`, all of which run SQL over
  three tables and read rows. They are now `/mem:recall` (find and answer), `/mem:sql`
  (numbers), `/mem:house` (what this is, whether it works, who can read it), `/mem:access`
  (invite and share) and `/mem:admin`.
- **The data model is written once, in `reference/HOUSE.md`.** The connection recipe was
  copy-pasted into eight skills, and the epoch filter — omit it and a real house
  over-counts by 34% — was explained in `ask/SKILL.md` and nowhere else, so `/mem:sql`,
  the skill most likely to produce a number someone acts on, never mentioned it. Schema,
  connection, the three traps and the known measurement gaps now live in one file every
  skill points at. 11,388 words became 5,854.
- **`/mem:recall` restores a name the canon already carried** (`TERMINOLOGY.md`: `memorecall`
  retired in favour of `/mem:recall`, 2026-07-29). Its description carries every trigger
  phrase the three skills it replaces had, so auto-triggering does not narrow.
- **The CLI no longer advertises a directory as a skill.** `plugins` listed
  `readdirSync(skills/)` verbatim; a `reference/` directory beside them would have been
  announced as `/mem:reference`. It now lists only directories carrying a `SKILL.md`.

## 0.16.0 — 2026-08-24

- **An unknown option now stops the run instead of being ignored.** Anything `--like-this`
  was accepted and silently discarded, which is quiet in the good case and dangerous in the
  bad one: `--dryrun` for `--dry-run` did not warn, it ran the migration; `--adopt` on a
  build predating that guard was swallowed and the invite proceeded into somebody else's
  house. Each command now declares what it takes (`memhouse/flags.js`), anything else exits
  2 naming the flag it probably meant, and a test holds the table against the flags
  `bin/memhouse.js` actually reads so the two cannot drift apart.
- **`whoami --admin` says when it fell back.** With no `MEMHOUSE_ADMIN_USER` set it
  resolved the ordinary credential and printed exactly what bare `whoami` prints, so the
  reader could not tell whether the flag had been heard. It now says so, and `--json`
  carries `admin_requested` / `admin_env_present`.

## 0.15.0 — 2026-08-24

- **`memhouse whoami` — which credential is in play, and what it may actually do.**
  `/mem:admin` was deciding that in prose: read some files, run `SHOW GRANTS`, grep the
  result. Reasoning about privileges in a skill gets it subtly wrong, and wrong here is
  either "you cannot" to an administrator or "go ahead" to a member about to hit
  ACCESS_DENIED. One command now answers it, with `--json` for agents and `--admin` to
  resolve `MEMHOUSE_ADMIN_USER`/`MEMHOUSE_ADMIN_PASSWORD`. It prints no password.
- **Capability detection is scope-aware, and shared.** The check `invite` shipped in
  0.14.0 matched privilege names anywhere in the grants — but a privilege only means what
  its scope allows, and an ordinary member holds `CREATE DATABASE` inside `ON <their-db>.*`,
  which mints no new house at all. It read as false only because the users half also
  failed; a member with any user-management grant would have been misjudged. The parser
  moves to `memhouse/capabilities.js`, keeps each grant's scope, and counts a privilege
  only when it is granted server-wide. `invite` and `whoami` share it, so they cannot
  disagree about who is an administrator.
- **`/mem:admin` stops inventing places to keep an admin password.** It looked in
  `~/.memhouse/admin.env` — a file memhouse never creates, and a bad idea besides: a
  member credential owns one database, an admin credential owns the server, and any
  process running as that user can read a file. The skill now calls `whoami --admin`,
  and when there is no administrator it says so and shows how to supply one for the
  current shell (`read -rs`, off the screen and out of history) rather than suggesting
  anything be written to disk.

## 0.14.0 — 2026-08-24

- **`memhouse invite` tells you the truth about your own credential, and gives a
  non-admin a way forward.** The capability probe was `SELECT 1 FROM system.users` — but
  since 0.12.6 every member is granted `SHOW USERS`, so *every member passed it*, was told
  "it can manage users on this house", and then failed three steps later at
  `CREATE DATABASE` with a raw `ACCESS_DENIED`. The probe now reads the credential's actual
  grants and requires real provisioning rights. When they are absent it says plainly that
  this is a member account, why a member cannot mint accounts, and splits the two cases:
  if you run the ClickHouse, pass the admin credential you created it with; if someone else
  runs it, you cannot invite at all — so `memhouse invite <name> --print-sql` now prints the
  exact statements to hand to whoever administers the server, contacting nothing.
- **An unreachable `--url` says so, instead of blaming your privileges.** The capability
  probe folded connection failure into the grants read, so a typo'd host, a down tunnel, or
  a loopback-bound `deploy --local` house all came back as "you are only a member" — sending
  the reader after a privilege they already held. Reachability is now checked first and
  reported as itself, naming the loopback case explicitly.
- **`--admin-password` is prompted for when omitted.** Passing it as a flag puts the
  password in the process list for the life of the request and in shell history unless the
  caller remembered a leading space. With a TTY it is now asked for instead; without one
  (an agent, CI) the old refusal stands, since there is nobody to ask. memhouse still never
  stores an admin credential — that stays deliberate.


## 0.13.0 — 2026-08-23

- **New skill: `/mem:admin`.** Every other skill is scoped to the caller's own house, so
  anything server-wide — list the accounts, size the houses, provision or remove a member,
  grant and revoke, read mutations and running queries — had no surface and became
  hand-written SQL with an admin password pasted into a chat that memhouse then archives.
  The skill resolves an admin credential from `MEMHOUSE_ADMIN_USER`/`MEMHOUSE_ADMIN_PASSWORD`,
  then `~/.memhouse/admin.env`, then the ordinary member credential (which IS the superuser
  on a `deploy --local` house), and *proves* it by checking `SHOW GRANTS` for
  `ACCESS MANAGEMENT` / `CREATE USER` / `CREATE DATABASE ON *.*` rather than assuming —
  `SHOW USERS` alone is a member privilege and does not qualify. Without one it refuses and
  names the two ways to supply it; it never asks for a password in the conversation and
  never echoes one. Destructive statements must be preceded by a SELECT of the same
  predicate, a report of what is actually there, and an explicit yes for that object.

- **`/mem:invite` now finishes the handoff.** The skill provisioned the member and
  stopped, leaving the user to work out where the credential file went and to compose the
  covering message themselves. It now runs the invite from the user's downloads directory
  (the file has to be attached to something, and it must never be left in a git repo —
  `invite-*.env` is gitignored here but not in whatever checkout they were standing in),
  confirms the file is present at mode 600 without ever printing its contents, reports
  whether the house was actually fresh, and drafts the message to send the invitee —
  install steps, that the file is a password, rotation on install, and `ship --full` when
  they are replacing an existing credential. It also handles the new occupied-house
  refusal: report the row count and let the user choose, never reach for `--adopt` on its
  own.

- **`memhouse invite` refuses a house that already holds someone's messages.** The house
  is created with `CREATE DATABASE IF NOT EXISTS`, so inviting a name whose database
  already existed silently *adopted* it — identical output to a fresh house, and the
  invitee landed on top of rows that were not theirs. Found the hard way: an invite meant
  for one person was sent to another, who shipped 3,733 messages under it; re-inviting the
  intended person reported success and would have handed over the first person's memory,
  with nothing on any surface saying so. Invite now counts the target's `messages` first
  and refuses with the row count, the writer count and three ways forward (different
  handle, different `--db`, or `--adopt` when sharing the house is the actual intent).
  Read-only and best-effort, so an admin that cannot count rows can still invite. The
  *user* half already behaved: `adminBootstrap` refuses an existing ClickHouse user, so an
  invite has never rotated a sitting member's password.

- **`memhouse relocate` needs `GRANT REMOTE ON *.*`, and no bootstrap granted it.**
  relocate runs from the *destination*, pulling the source over `remoteSecure()` — a
  table function ClickHouse gates behind its own access type, separate from `GRANT ALL`
  on a database. Every member created via `invite` or the admin install had `ALL`,
  `SHOW USERS` and self-`ALTER USER`, but not this — so `relocate` failed at the
  native-reachability probe with `ACCESS_DENIED` for any member, source always left
  untouched. Found by running it. Both grant paths (`adminBootstrap` and the
  `--print-sql` template) now include `GRANT REMOTE ON *.* TO <member>`, best-effort
  like the other two. Existing members are unaffected; grant them by hand:
  `GRANT REMOTE ON *.* TO <member>`.

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
