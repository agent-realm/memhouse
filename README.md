# memhouse

**memhouse** — agent conversation memory as a product. Every coding-agent session
on your machines — across the **17 editors** the agentlytics adapters support —
parsed locally, shipped to a typed ClickHouse store, shareable with a team,
installable on the ultimagent kernel as an **agency**, and visible through the
agentlytics dashboard unchanged.

**One house, a set of rooms per member.** Each member owns
`sessions_<them>`, `messages_<them>`, `tool_calls_<them>`, and holds grants on
those and nothing else — isolation is a grant that is simply absent, so it fails
closed. All of *your* machines ship into *your* rooms (the `host` column tells them
apart); another member's machines never do. A team-wide read is a `Merge` room plus
a `GRANT`, which narrows to whatever the caller can already see.

There is no shared-table layout. That was memory-house's model and 0.4.0 removed it.

An **agency** in the constellation sense (`TERMINOLOGY.md`): a **house** — the
`mem` database — plus a **resident** working in it, the shipper. The test is
what writes. The shipper fires on its own loop and puts rows in the house that
outlive any query; everything else here is only ever read. The house alone would
hold; the shipper is what makes it act.

An alternative agency **competing with memory-house**; if it wins, it becomes
memory-house v4. Start with `mem-house/DESIGN.md` for the four bets
(parse-on-client, typed common schema, kernel-agency, borrowed UI).

## Layout

| Path | What |
|---|---|
| `mem-house/` | the product: `DESIGN.md`, `per-member/`, `shipper/`, `server/`, `delivery/` |
| `editors/` | the 17 editor adapters (inherited from agentlytics; the crown jewels) |
| `pricing.js` + `pricing.json` | the cost engine |
| `ui/` | the dashboard SPA (built to `public/`, served unchanged by the memhouse server) |
| `agency/` | the earlier agentlytics-agency wrap (raw canonical shape) — kept as prior art |
| `TERMINOLOGY.md` | the constellation terminology canon + how it applies here |
| everything else at root | upstream agentlytics (see `AGENTLYTICS-README.md`), still runnable |

## Quickstart — the `memhouse` CLI

```bash
npm install -g memhouse --allow-scripts=better-sqlite3
memhouse onboard          # wizard: discover → configure → ship → start
```

**Do not drop `--allow-scripts=better-sqlite3`.** Five adapters — cursor, goose,
opencode, zed, and antigravity — read sessions out of SQLite files, and
`better-sqlite3` builds its native binding from an install script. npm 12 blocks
install scripts by default, so without the flag those five read nothing and you
silently ship a partial history. `memhouse discover` and `memhouse doctor` both
say so when the binding is missing.

If that install fails with `EACCES`, `sudo` is the right answer for only one of the
two causes, and the thing that tells them apart is **who owns the prefix root** —
not the path, and not the failing file. The path proves nothing: Homebrew's prefix
is `/usr/local` on Intel and `/opt/homebrew` on Apple Silicon, and is yours in both
cases. The failing file proves nothing either: an earlier `sudo npm` leaves
root-owned files *inside* a prefix that is still yours.

```bash
ls -ld "$(npm prefix -g)"     # the prefix ROOT — this is the deciding one
```

- **Prefix root owned by `root`** — a genuinely system-managed Node (distro
  packages under `/usr`). Re-run with `sudo`.
- **Prefix root owned by you** — the prefix is yours (Homebrew, fnm, nvm, volta),
  so whatever root-owned file npm tripped on is a stray from an earlier `sudo npm`.
  Another `sudo` adds more of them. Repair just that path:
  `sudo chown -R "$(id -u):$(id -g)" <the path npm named>`. The same applies to the
  cache (`~/.npm`).

To try it without installing, npx takes the same flag — it has to come before the
package name:

```bash
npx --allow-scripts=better-sqlite3 -y memhouse discover
```

Working from a checkout instead: `npm install` (the repo's `allowScripts` field
covers the binding), then `node bin/memhouse.js …`. `npm test` is a syntax gate plus
unit checks; `misc/tier-matrix-test.sh` walks the tier/ownership matrix against a real
container engine on Linux and takes a few minutes, so it is not part of `npm test`.

```text
memhouse onboard | install | setup | discover | uninstall | reset
memhouse ship [--full|--loop N] | stats | search <terms> | start | stop | status | doctor
memhouse plugins install claude | prompt
memhouse deploy --local | --down                # stand up a house to point at
memhouse service install | uninstall | status   # survive a reboot
```

### Where the memory lives

`memhouse onboard` assumes you already have a ClickHouse. If you do not, `deploy`
is the missing first mile:

| | What it runs | Who it is for |
|---|---|---|
| `deploy --local` | stock ClickHouse in docker or podman, loopback-bound | one machine, or several members later |
| kernel install | an agency house on an ultimagent kernel | a team, provisioned centrally |
| point at your own | any reachable ClickHouse — a server, ClickHouse Cloud | you already have one |

`deploy --local` needs docker or podman. If you have neither and no ClickHouse, install
one of them — memhouse does not embed a database. An earlier `--solo` tier ran chdb
behind a hand-written ClickHouse-HTTP shim and was removed: emulating the HTTP protocol
meant every setting or request shape the shim did not implement became a silently wrong
answer, and half the defects found reviewing this branch came from it.

`deploy` labels what it creates and refuses to replace or remove a container or
volume it did not create, so a name collision costs you an error rather than
somebody else's data.

### Surviving a reboot

`memhouse start` detaches with pidfiles: the daemons outlive the shell, and nothing
brings them back after a restart. `memhouse service install` writes a real user
service instead — systemd `--user` on Linux, a launchd LaunchAgent on macOS — and
takes over from the pidfile daemons. On Linux a `--user` unit stops at logout
unless lingering is on, so install detects that and prints the `loginctl` command.

### One set of rooms per member

Every member owns their rooms — `messages_alice`, `sessions_alice`,
`tool_calls_alice`. This is the only layout. Isolation is a grant that is simply
absent, not a row policy that has to be right on every table and every read path, so it
fails closed. A shared read is a Merge room (`all_sessions`) plus a GRANT, which reduces
to whatever rooms the caller can already read — strictly less machinery than the policy
it replaced.

The session rollup is a saved query over those rooms rather than a stored view, so there
is no fourth object to provision, grant, or collide with the team rooms;
`memhouse sessions-query` prints it. On a house you own, `memhouse install` mints your
three rooms and you are done. On someone else's, the owner mints them
(`mem-house/per-member/provision.js`) and sharing a whole room is then self-serve, with
no operator. Design and measurements: `mem-house/per-member/`.

Every command is dual-mode: interactive for humans, `--yes`/flags/`--json` for
agents — so an agent can self-install its own memory (`memhouse install --yes …`,
`memhouse plugins install claude`). Config: flags > `MEMHOUSE_*` env >
`~/.memhouse/env` > defaults.

Deeper docs: `mem-house/delivery/AGENT-INSTALL.md`, kernel install (agency
`memhouse`, members, per-member rooms and their grants):
`mem-house/delivery/kernel-install.md`, skills/plugin payloads: `mem-house/delivery/`.

## Heritage & license

Built on [agentlytics](https://github.com/f/agentlytics) by Fatih Kadir Akın (MIT)
— the adapters, dashboard, and cost engine come from there (this repo's history
carries the full lineage). The `agentlytics` remote tracks the private working
mirror for syncing adapter improvements both ways.
