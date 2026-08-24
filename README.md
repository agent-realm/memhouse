# memhouse

**Claude Code deletes your transcripts after 30 days.** (`cleanupPeriodDays`,
default 30 — session files are removed at startup.) Measured on the machine this
was built on: months of daily use, and the oldest surviving local transcript was
nine days old. Every problem you solved before that exists nowhere — unless
something durable was keeping it.

memhouse is that something. It reads the session transcripts your editors already
write to disk — **17 of them**: Claude Code, Codex, Cursor, Zed, Copilot, Gemini
CLI and the rest — parses them locally, and ships typed rows into a ClickHouse
**you own**. Nothing is proxied, intercepted, or sent to anyone's cloud. Then you
can search every past session, see what it cost, resume the conversation that
solved this before, and let an agent query its own history.

And every row says where it came from, in a way no client can fake: `user_id` is
stamped **by the server** (`MATERIALIZED currentUser()`, async inserts pinned off
so the stamp cannot be skipped) and `host` is a fingerprint minted once per
install. A team pointed at one house is a team memory with real attribution — not
a label somebody's client claimed.

```bash
npm install -g memhouse
memhouse onboard
```

That is the whole install — no flags, nothing to compile. `onboard` finds your
editors, sets up a house, ships, and starts the dashboard.

**On most Linux distros that first line needs `sudo`.** A distro-packaged Node puts
its global prefix under `/usr`, which you do not own, so npm stops with `EACCES`.
That is the single most likely place a first install stalls — measured on a clean
Ubuntu machine:

```bash
ls -ld "$(npm prefix -g)"     # root-owned? use sudo. Owned by you? do NOT — see EACCES below
sudo npm install -g memhouse
```

If the prefix is yours (Homebrew, fnm, nvm, volta), `sudo` is the wrong fix and
makes it worse — [EACCES on install](#eacces-on-install) tells them apart.

## No ClickHouse yet?

`onboard` offers to run one for you if docker or podman is present:

```bash
memhouse deploy --local      # a loopback-bound ClickHouse, then install and ship
```

The house it stands up is **yours by name**: its superuser defaults to your OS
username (`polat`, not `memhouse_root` — override with `--user`), and the house
database defaults to the same name, so your memory lives at `polat.messages` and
`WHERE user_id = 'polat'` reads like it should. The name
and password are fixed when the data volume is first initialised, like any ClickHouse
container, and reused on every redeploy after that.

Otherwise point at one you already run, or hand the SQL to whoever administers it:

```bash
memhouse install --url https://… --user … --password …   # one you have
memhouse install --admin-user … --admin-password …       # let memhouse build it
memhouse install --print-sql                             # print the SQL, run it yourself
```

memhouse does not embed a database. If you have neither a ClickHouse nor a
container engine, install one of the two.

## Commands

```text
memhouse onboard | install | setup | discover | doctor | uninstall | reset
memhouse ship [--full|--loop N] | search <terms> | stats | status
memhouse resume <session-id>               print the command that reopens a session
memhouse update [--check]                  upgrade, restart daemons, check the schema
memhouse start | stop                      dashboard + shipper as daemons
memhouse service install | uninstall       survive a reboot
memhouse deploy --local | --down           stand up (or remove) a local house
memhouse invite <name>                     mint a member + house, hand them one env file
memhouse passwd                            rotate this member's password
memhouse migrate | migrate-rooms [--dry-run] [--yes]
                                           run whatever this house still needs
memhouse relocate --to <url>               copy this house to a new ClickHouse, then repoint
memhouse nightly [--out DIR]               build an installable tarball from this checkout
memhouse plugins install claude            9 skills — ask, hello, invite, search,
                                           sessions, share, sql, status, users — into
                                           every Claude Code config dir found
memhouse mcp                               MCP server on stdio — the same memory for
                                           every MCP client, not just Claude Code
memhouse prompt                            memory snippet for an agent's system prompt
memhouse prompt --install                  an install prompt, rendered for this machine
```

Any command's own usage: `memhouse <command> --help` (or `-h`) — always prints usage,
never runs the command.

Every command works both ways: interactive for you, `--yes` / flags / `--json` for
an agent — so an agent can install its own memory unattended.

`onboard` offers the skills at the end, and `plugins` works across **every Claude Code
config directory on the machine** — `~/.claude`, whatever `CLAUDE_CONFIG_DIR` points
at, and each Kommander-style playbook under `~/.claude-playbooks/`. All are selected by
default; answer with numbers to narrow it, or pass `--target DIR` for exactly one.
Installing into just the default config is how `/mem:recall` ends up missing from
the instance you actually work in, silently, since a missing skill never announces
itself.

Config resolves: flags → `MEMHOUSE_*` env → `$MEMHOUSE_HOME/env` (default
`~/.memhouse/env`). There is no house-shaped default: with nothing configured, the
commands that read or write memory refuse and say so rather than guessing
`localhost:8123`, which on a lot of machines is a real house belonging to someone else.

## The same memory from any client — MCP

The Claude Code skills reach only Claude Code. `memhouse mcp` serves the house over
MCP, so every client that speaks it — Claude Desktop, Cursor, Windsurf, Copilot,
Goose, and the rest — reads the same memory. memhouse already parses 17 editors'
conversations; MCP is how all of them read them back.

Register it as a stdio server (every client supports that form):

```json
{ "mcpServers": { "memhouse": { "command": "memhouse", "args": ["mcp"] } } }
```

Seven read-only tools, named to match the `/mem:*` skills so the vocabulary carries
across surfaces: `search` returns a compact index where every hit carries
`est_expand_tokens` — the price of fetching that whole session — so the model spends
its context on the sessions worth it; `get_session` fetches the transcript (or a
`seq` slice) for the ids it chose; `sessions` gives chronological context around a
hit; `status` shows what the house holds and how fresh it is; `users` answers who
writes into this house and whose houses you can read; `resume_command` turns a hit
into the paste-ready command that reopens it in its own editor; `sql` is free-form
read-only SQL for everything else.

The write-side skills — `/mem:share`, `/mem:invite` — have no MCP counterpart on
purpose. This endpoint issues no GRANT and mints no user; read-only is a property of
the surface, not a default.

`sql` runs under the credential the server was configured with, and what it may READ
is that credential's **grants** — ClickHouse enforces them, and a server refusal comes
back verbatim as the answer. Point the server at a `GRANT SELECT`-only user for a
read-only surface no application code has to get right. One rule is memhouse's own:
table functions that reach off this ClickHouse (`remote`, `url`, `s3`, …) are refused
before the query is sent.

The server also mounts on the dashboard at `POST /mcp` (loopback, same process, no
extra daemon) for clients that prefer Streamable HTTP. Both transports speak the
stateless 2026-07-28 protocol revision *and* the classic `initialize` handshake, so
today's clients and next year's both work. With no house configured the server still
starts and lists its tools — each call then explains what to set up, instead of the
client reporting an opaque "server failed".

## Going back into a session

`search` finds the conversation; `resume` hands you back into it.

```bash
memhouse resume claude:6b1f…            # prints:  cd /path/to/project && claude --resume 6b1f…
```

It **prints** the command instead of running it. A resume run from the wrong directory
or with a stale id does not fail — it opens a *new* session, and the transcript you
wanted is still gone while the tool reports success. You paste it, so you see it first.

Verified for **claude, codex and opencode**. Cursor, Zed, VS Code, Kiro, Copilot for
JetBrains, Antigravity and Devin/Windsurf have no CLI that takes a session id, so
there is nothing to resume into and `resume` says exactly that, rather than opening a
folder and calling it the same thing. Everything else — goose, gemini-cli,
cursor-agent, copilot-cli — is refused as *unverified*, which is a different sentence
on purpose: nobody has read the flag out of its own `--help` yet, and guessing is how
you print a command that quietly does the wrong thing. See `memhouse/resume.js`.

## Which machine is which

All of *your* machines ship into *your* rooms, and the `host` column is what tells them
apart. So each install writes `~/.memhouse/host.json` — a random fingerprint, minted once
— and every row that machine ships carries `<hostname>-<8 hex>` built from it.

Random, not derived, because deriving it fails in both directions: two laptops that both
answer to the default `MacBook-Pro` on the same platform hash to the **same** id and merge
into one apparent machine, and renaming a machine **moves** a derived id so its own history
appears to stop and a stranger's to begin. A stored fingerprint cannot collide and does not
move — rename the machine and `status` says so while the id stays put.

```bash
memhouse status     # ✓ host: macminim-4127a95b
memhouse doctor     # names every host in your rooms, and whether this one is among them
```

Then query one machine with `WHERE host = 'macminim-4127a95b'`.

## Uninstalling, in three tiers

```bash
memhouse uninstall                   # stop everything; KEEP the config and this host's identity
memhouse uninstall --credentials     # also forget the house and its password
memhouse uninstall --full-removal    # all of ~/.memhouse, identity included
```

The default is deliberately the conservative one. Stopping the shipper is routine — before
an upgrade, while debugging, when a laptop should go quiet for a week — and it should not
also mean "forget which house I use and who this machine is". `--full-removal` asks first,
because a later reinstall mints a **new** identity and this machine then reads as two
machines in your history.

**No tier touches your memory.** Transcripts live in ClickHouse, and everything the shipper
wrote rebuilds from the local session stores with `ship --full`.

## Staying current

```bash
memhouse update            # upgrade, restart the daemons, check the house schema
memhouse update --check    # compare versions, change nothing
```

A bare `npm i -g memhouse@latest` does half the job. It does not restart the daemons,
which keep parsing with the code they booted with (a shipper here once ran 1d16h out of
a directory that had been *moved*); and it does not check whether your house predates a
room the new shipper needs. `update` does both, and from a checkout it rebuilds
`public/` — otherwise `git pull` serves you the previous release's dashboard forever.

The daemons also notice on their own: each one compares the installed version against
what it booted with and hands over — exiting under systemd/launchd so the supervisor
restarts it, re-execing itself when nothing is supervising. `update` just makes it
immediate.

## How your memory is stored

**A house is a database; its rooms are three shared tables.** `sessions`, `messages`
and `tool_calls` live in whatever database you point at — your own name by default
(`polat.messages`), a team's (`team_a.messages`), even `default`. Everyone in the
house writes into the same tables with their own credential, and every row says where
it came from: `user_id`, stamped by the server (`MATERIALIZED currentUser()`, with
async inserts pinned off so the stamp cannot be skipped), and `host`, the machine's
install fingerprint.

`WHERE user_id = 'alice'` is one person. `WHERE host = '…'` is one machine. No filter
is the whole house — which is exactly what a team dashboard wants.

Sharing is not a feature bolted on top; it IS the house. A team makes a database,
grants each person `ALL` on it, and their shippers all write into the same rooms:

```sql
CREATE DATABASE team_a;
CREATE USER alice IDENTIFIED BY '…';
GRANT ALL ON team_a.* TO alice;    -- repeat per housemate
```

`ALL` on your own house reaches nothing outside it — the database is the boundary,
which is also why joining a ClickHouse someone else runs (a kernel's, a team's) needs
no negotiation beyond a database and a credential. Housemates are collaborators;
groups that should not see each other get separate houses.

### The house never destroys what it cannot rebuild

**The shipper is insert-only.** It runs no `DELETE`, no `TRUNCATE`, no mutation of any
kind, so no privilege it holds can lose you a row.

That is not free, because ReplacingMergeTree is a dedupe engine, not a diff engine: a
re-parse yielding *fewer* messages leaves the old higher-`seq` rows with nothing written
over them. The shipper used to delete the session's rows first to clear that tail — and
a shorter re-parse has two indistinguishable causes. Either an adapter bug was fixed and
the extra rows are junk, or Claude Code **compacted** the transcript, or the retention
window (`cleanupPeriodDays`, 30 days by default) took it. In the last two cases the house
holds the only surviving copy, and the delete destroyed it.

So rows carry an `epoch`: which parse of the session they belong to.

- **Nothing changed** (the common case, including ordinary growth): same epoch, rows
  dedupe exactly as before, no extra storage.
- **Shorter, or rewritten at a position the house already holds**: the new parse goes to
  `epoch + 1`. The old one stays complete and readable. You pay storage only when the old
  rows are irreplaceable.

Reads show one parse per session — the newest — so counts, tokens and cost are unchanged.
`/mem:sql` and any hand-written query should filter the same way; the skill carries
the clause.

**Imported history is protected the same way.** `origin` says who wrote a row, and it is
in the sorting key of `messages` and `tool_calls`, so ReplacingMergeTree cannot collapse
an imported row against a shipped one. Anything you imported from an older house, another
product, or a machine that no longer exists survives every re-ship. `sessions` is the
deliberate exception — one row per session, no `origin` and no `epoch` in its key, because
a session's metadata has a single current version and a second row makes every rollup
count its messages twice.

The shipper verifies the sorting keys before it writes and refuses if they are wrong, so
an old house cannot be corrupted by a new shipper. `memhouse migrate-rooms` rebuilds it:
copy, atomic swap, and the old room kept as `<room>_pre_epoch` for you to drop. The house
records the move in `house_events`, and `memhouse doctor` reads it back.

## Upgrading

`memhouse update` upgrades the code, restarts the daemons, and — from 0.10.0 onward —
detects a schema migration the house needs and prompts to run it.

**One exception: upgrading from 0.9.x.** That release predates migrations, and `update`
runs the *old* version's code (it replaces itself mid-run), so it cannot prompt. After
the upgrade the first ship refuses (nothing is lost) and tells you the one command to
run by hand:

```bash
memhouse update      # installs the new version, refuses to ship the old-schema house
memhouse migrate     # the one-time rebuild it named — copy + atomic swap, nothing deleted
memhouse doctor      # every line a check mark
```

If other machines ship into the same house as the same member, upgrade them too — a
pre-0.10 shipper still deletes-before-reinsert; `memhouse doctor` flags any that are
behind, and prints the `REVOKE ALTER DELETE, ALTER UPDATE` fallback that stops them
destructively until you can.

## Troubleshooting

### An editor reads zero sessions

Five adapters — **cursor, zed, opencode, goose, antigravity** — read sessions out of
SQLite files. That used to mean `better-sqlite3`, whose native binding is built by
an npm install script; npm 12 blocks install scripts by default, so a plain install left
all five reading nothing and the fix was a flag
(`--allow-scripts=better-sqlite3`) you had to re-type on every upgrade. SQLite is
`node:sqlite` now — part of Node — so that failure class is gone along with the flag.

What can still go wrong is one store at a time: a `state.vscdb` locked by a running
editor, a corrupt file, a schema a new editor release changed. None of it is silent —
`memhouse discover` and `memhouse doctor` both name the skipped adapter and say why,
and the other sixteen keep working.

```bash
npx -y memhouse discover      # no flags here either
```

### `EACCES` on install

`sudo` is right for only one of the two causes, and what tells them apart is **who
owns the prefix root** — not the path, and not the file npm named.

```bash
ls -ld "$(npm prefix -g)"
```

- **Owned by `root`** — a system-managed Node (distro packages under `/usr`).
  Re-run with `sudo`.
- **Owned by you** — the prefix is yours (Homebrew, fnm, nvm, volta), so the
  root-owned file npm tripped on is a stray from an earlier `sudo npm`. Another
  `sudo` adds more. Repair just that path:
  `sudo chown -R "$(id -u):$(id -g)" <the path npm named>`. Same for `~/.npm`.

The path proves nothing on its own: Homebrew's prefix is `/usr/local` on Intel and
`/opt/homebrew` on Apple Silicon, and is yours in both cases.

### Daemons don't survive a reboot

`memhouse start` detaches with pidfiles — they outlive the shell, not a restart.
`memhouse service install` writes a real user service instead (systemd `--user`,
or a launchd LaunchAgent) and takes over. On Linux a `--user` unit stops at logout
unless lingering is on; install detects that and prints the `loginctl` command.

A rootless podman house has the same problem for the same reason, and
`deploy --local` says so.

## Working from a checkout

```bash
npm install            # two runtime deps, no build step
node bin/memhouse.js …
npm test               # syntax gate + unit checks
```

`misc/origin-matrix.sh <label> <url> <user> <pass>` checks the import-protection
guarantees against a real ClickHouse. `misc/tier-matrix-test.sh` walks the
tier/ownership matrix against a real container engine on Linux. Both take minutes
and are not part of `npm test`.

## Layout

| Path | What |
|---|---|
| `memhouse/` | the product — `DESIGN.md`, `per-member/`, `shipper/`, `server/`, `delivery/` |
| `editors/` | the 17 editor adapters (inherited from agentlytics; the crown jewels) |
| `pricing.js` + `pricing.json` | the cost engine |
| `ui/` | the dashboard SPA (built to `public/`, served by the memhouse server) |
| `agency/` | the earlier agentlytics-agency wrap — prior art, not how memhouse works |
| `TERMINOLOGY.md` | the constellation terminology canon |

Deeper reading: `memhouse/DESIGN.md` (the four bets),
`memhouse/per-member/INSTALL.md` (the three install paths and every refusal),
`memhouse/per-member/SCHEMA.md`, `memhouse/delivery/kernel-install.md`,
`memhouse/COMPETITION.md`.

Deferred designs (captured, not yet built): `docs/design/host-repoint-reconciliation.md`
— what should happen when the shipper is repointed at a new, empty host (house identity,
local binding state, and a refuse-then-`init-here` gate so transcripts never land on the
wrong server).

In constellation terms (`TERMINOLOGY.md`) memhouse is an **agency**: a **house**
— the `mem` database — plus a **resident** working in it, the shipper. The house
alone would hold; the shipper is what makes it act. It competes with
memory-house; if it wins, it becomes memory-house v4.

## What's supported

| Surface | Status |
|---|---|
| macOS | primary — developed and driven here daily |
| Linux | real — installs, ships, `service install` (systemd `--user`), rootless podman `deploy --local`; exercised on Debian and Ubuntu machines |
| Windows | **untested** — the adapters declare Windows paths but no one has run a single install; treat it as unknown until this row changes |
| ClickHouse | 25.11 and 26.x, both in CI; 26.2+ needs no flags, 25.x needs the text-index flag the shipper already passes |
| Node | **≥ 24** — SQLite comes from `node:sqlite`, which is stable in 24. It works flagless on 22.13+ but prints `ExperimentalWarning` on every command (measured on v22.23.2), and Node 20 is past EOL. There is no native dependency and no build step at any version. |

## Heritage & license

Built on [agentlytics](https://github.com/f/agentlytics) by Fatih Kadir Akın (MIT)
— the adapters, dashboard, and cost engine come from there, and this repo's history
carries the full lineage. MIT.
