# memhouse

**Your coding agents forget. Their transcripts get deleted too.** Claude Code removes
session files after 30 days (`cleanupPeriodDays`); on the machine this was built on, the
oldest surviving local transcript was nine days old. Every problem solved before that
exists nowhere, unless something durable kept it.

memhouse keeps it. It reads the session transcripts your editors already write to disk
(16 adapters covering 18 apps: Claude Code, Codex, Cursor, Zed, Copilot, Gemini CLI and
the rest), parses them locally, and ships typed rows into a ClickHouse **you choose**. That
can be a container on this laptop, a box you run, your company's cluster, or ClickHouse
Cloud. memhouse runs no service of its own and proxies nothing. Then you, and your agents,
can search every past session, see what it cost, and reopen the one that solved this
before.

Every row says where it came from, in a way no client can fake. `user_id` is stamped by
the server (`MATERIALIZED currentUser()`), and `host` is a fingerprint minted once per
install. A team pointed at one house gets a shared memory with real attribution.

## Install

```bash
npm install -g memhouse      # Node 24+; on a distro-packaged Node this needs sudo
memhouse onboard             # finds your editors, sets up a house, ships, starts the dashboard
```

No ClickHouse yet? `memhouse deploy --local` runs one in docker or podman, bound to
loopback, and installs against it. Already have one, or an invite from someone who does?
See [install and onboard](docs/guides/install.md).

## What you get

```bash
memhouse status                  # is it shipping, and how fresh
memhouse search "auth error"     # full-text across every session, every machine
memhouse resume claude-code:6b1f… # prints the command that reopens that session
memhouse plugins install claude  # /mem:recall and four more skills for your agents
```

The dashboard is at `http://localhost:4640`, showing sessions, cost, models, tools and
machines. From any Claude Code session, `/mem:recall how did I fix the ClickHouse auth
error` answers from your own history.

## Documentation

| | |
|---|---|
| [Tutorials](docs/README.md#tutorials) | your first house, joining a team's house, sharing memory |
| [Guides](docs/README.md#guides) | install, update, invite, share, admin credentials, daemons, search, troubleshooting |
| [Examples](examples/README.md) | runnable setups, from one machine up to a self-hosted team house |
| [Release notes](docs/releases/) | what changed in each version, and how to upgrade |
| [`AGENTS.md`](AGENTS.md) | installing memhouse as an agent, and working on this repository |

Any command's own usage: `memhouse <command> --help`. Every command works both ways:
interactive for you, and `--yes` / flags / `--json` for an agent.

## What's supported

| Surface | Status |
|---|---|
| macOS | primary; developed and driven here daily |
| Linux | installs, ships, `service install` (systemd `--user`), rootless podman `deploy --local`; exercised on Debian and Ubuntu |
| Windows | **untested**; the adapters declare Windows paths, but no one has run an install |
| ClickHouse | 25.11 and 26.x, both in CI |
| Node | **24 or newer**. SQLite comes from `node:sqlite`; no native dependency, no build step |

## Working from a checkout

```bash
npm install            # two runtime dependencies, no build step
node bin/memhouse.js …
npm test               # syntax gate + unit checks
```

See [`AGENTS.md`](AGENTS.md) before your first change. Deeper reading:
`memhouse/DESIGN.md` (the design and why), `memhouse/house/HOUSE.md` (layout and schema),
`SECURITY.md` (what holds, and what does not).

## Heritage and license

Built on [agentlytics](https://github.com/f/agentlytics) by Fatih Kadir Akın (MIT). The
adapters, dashboard and cost engine come from there, and this repository's history carries
the full lineage. MIT.
