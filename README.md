# memhouse

Long-term memory for coding agents. memhouse reads the session transcripts your
editors already write to disk — **17 of them**, Claude Code, Codex, Cursor, Zed,
Copilot, Gemini CLI and the rest — parses them locally, and ships typed rows into
ClickHouse. Nothing is proxied or intercepted. Then you can search every past
session, see what it cost, and let an agent query its own history.

```bash
npm install -g memhouse --allow-scripts=better-sqlite3
memhouse onboard
```

That is the whole install. `onboard` finds your editors, sets up a house, ships,
and starts the dashboard. **Don't drop `--allow-scripts`** — see
[below](#the-allow-scripts-flag).

**On most Linux distros that first line needs `sudo`.** A distro-packaged Node puts
its global prefix under `/usr`, which you do not own, so npm stops with `EACCES`.
That is the single most likely place a first install stalls — measured on a clean
Ubuntu machine:

```bash
ls -ld "$(npm prefix -g)"     # root-owned? use sudo. Owned by you? do NOT — see EACCES below
sudo npm install -g memhouse --allow-scripts=better-sqlite3
```

If the prefix is yours (Homebrew, fnm, nvm, volta), `sudo` is the wrong fix and
makes it worse — [EACCES on install](#eacces-on-install) tells them apart.

## No ClickHouse yet?

`onboard` offers to run one for you if docker or podman is present:

```bash
memhouse deploy --local      # a loopback-bound ClickHouse, then install and ship
```

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
memhouse plugins install claude            /memhouse:search, :sessions, :sql
memhouse prompt                            memory snippet for an agent's system prompt
memhouse prompt --install                  an install prompt, rendered for this machine
```

Every command works both ways: interactive for you, `--yes` / flags / `--json` for
an agent — so an agent can install its own memory unattended.

Config resolves: flags → `MEMHOUSE_*` env → `$MEMHOUSE_HOME/env` (default
`~/.memhouse/env`). There is no house-shaped default: with nothing configured, the
commands that read or write memory refuse and say so rather than guessing
`localhost:8123`, which on a lot of machines is a real house belonging to someone else.

## Going back into a session

`search` finds the conversation; `resume` hands you back into it.

```bash
memhouse resume claude:6b1f…            # prints:  cd /path/to/project && claude --resume 6b1f…
```

It **prints** the command instead of running it. A resume run from the wrong directory
or with a stale id does not fail — it opens a *new* session, and the transcript you
wanted is still gone while the tool reports success. You paste it, so you see it first.

Verified for **claude, codex and opencode**. The GUI editors — cursor, zed, vscode,
copilot, windsurf and the rest — have no CLI that takes a session id, so there is
nothing to resume into and `resume` says so rather than opening a folder and calling
it the same thing. Adding an editor means reading its real `--help`, not guessing:
see `memhouse/resume.js`.

## Staying current

```bash
memhouse update            # upgrade, restart the daemons, check the house schema
memhouse update --check    # compare versions, change nothing
```

A bare `npm i -g memhouse@latest` does one third of the job. It does not re-pass
`--allow-scripts=better-sqlite3`, so the five SQLite adapters go quiet; it does not
restart the daemons, which keep parsing with the code they booted with (a shipper here
once ran 1d16h out of a directory that had been *moved*); and it does not check whether
your house predates a room the new shipper needs. `update` does all three, and from a
checkout it rebuilds `public/` — otherwise `git pull` serves you the previous release's
dashboard forever.

The daemons also notice on their own: each one compares the installed version against
what it booted with and hands over — exiting under systemd/launchd so the supervisor
restarts it, re-execing itself when nothing is supervising. `update` just makes it
immediate.

## How your memory is stored

**One house, one set of rooms per member.** You own `sessions_<you>`,
`messages_<you>`, `tool_calls_<you>` in the `mem` database, and hold grants on
those and nothing else. Isolation is a grant that is simply *absent*, so it fails
closed — no row policy that has to be right on every table and every read path.

All of *your* machines ship into *your* rooms; the `host` column tells them apart.
Another member's machines never do. A team-wide read is a `Merge` room
(`all_sessions`) plus a `GRANT`, which narrows to whatever the caller can already
see. Sharing a whole room needs no operator.

The member name comes from the server — `SELECT currentUser()` — not from your
config. A client that could name its own member could write into someone else's
rooms.

### Imported history is protected

Rows carry an `origin`. The shipper clears a session before re-inserting it, so a
shorter re-parse can't leave a stale tail behind — but that clear only removes rows
the shipper itself wrote (`origin='ship'`). Anything you imported from an older
house, another product, or a machine that no longer exists survives a re-ship.

`origin` is in the sorting key of `messages` and `tool_calls` too, so
ReplacingMergeTree can't quietly collapse an imported row against a shipped one. Both
halves matter: guarding only the delete still loses data, through the merge instead of
the mutation.

`sessions` is the deliberate exception — one row per session, no `origin` in its key.
A session's metadata has a single current version, and keying it on origin gives the
same session two rows, which makes every rollup count its messages twice.

The shipper checks both directions before it writes and prints the rebuild if a house
has it wrong, so an old house cannot be corrupted by a new shipper.

## Troubleshooting

### The `--allow-scripts` flag

Five adapters — **cursor, zed, opencode, goose, antigravity** — read sessions out
of SQLite files, and `better-sqlite3` builds its native binding from an install
script. npm 12 blocks install scripts by default, so without the flag those five
read nothing and you ship a partial history.

(This said six and named windsurf, which is wrong: windsurf lists its sessions over
language-server RPC and touches SQLite only to read a usage key, so a dead binding
costs it numbers, not sessions. `editors/index.js` has the real list.)

It is not silent: `memhouse discover` and `memhouse doctor` both name the skipped
adapters. The other twelve adapters keep working.

`npx` takes the same flag, before the package name:

```bash
npx --allow-scripts=better-sqlite3 -y memhouse discover
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
npm install            # the repo's allowScripts field covers the binding
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

In constellation terms (`TERMINOLOGY.md`) memhouse is an **agency**: a **house**
— the `mem` database — plus a **resident** working in it, the shipper. The house
alone would hold; the shipper is what makes it act. It competes with
memory-house; if it wins, it becomes memory-house v4.

## Heritage & license

Built on [agentlytics](https://github.com/f/agentlytics) by Fatih Kadir Akın (MIT)
— the adapters, dashboard, and cost engine come from there, and this repo's history
carries the full lineage. MIT.
