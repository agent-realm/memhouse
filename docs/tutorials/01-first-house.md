# Tutorial 1: your first house

One machine, about ten minutes. At the end, every coding-agent session on this machine
is in a ClickHouse you own. You can see them in a dashboard, search them, and ask an agent
about them.

**You need:**

- Node 24 or newer;
- docker or podman, for the local ClickHouse;
- at least one editor that has written sessions: Claude Code, Codex, Cursor, Zed, and so on.

## 1. Install

```bash
npm install -g memhouse
```

On a distro-packaged Node (Linux, global prefix under `/usr`) this needs `sudo`. On
Homebrew, nvm, fnm or volta it must not have it. [The install guide](../guides/install.md#eacces-on-install)
tells the two apart.

## 2. See what is on this machine

```bash
memhouse discover
```

This is a read-only preflight. It lists every editor it found, how many sessions each one
holds, the directories it watches, and any ClickHouse it can reach. Nothing is written
anywhere.

## 3. Stand up a house

```bash
memhouse deploy --local
```

This does four things:

1. It starts ClickHouse in a container bound to `127.0.0.1:8123`, so only this machine
   can reach it. The data lives in a named volume.
2. It creates two users. `memhouse_root` administers the house. A **member** named after
   your OS user (`polat`, say) ships your sessions, and holds one grant: `mem.polat_*`.
   Your rooms are `mem.polat_sessions`, `mem.polat_messages`, `mem.polat_tool_calls`, and
   so on.
3. It writes both credentials to `~/.memhouse/env`, mode 600. A local house is the one
   case where the admin credential is kept, so that `memhouse invite` works later with
   no flags.
4. It installs against the house and ships everything once.

Already have a ClickHouse? Skip this step and use `memhouse onboard`, which asks for
it. See [the install guide](../guides/install.md).

## 4. Check it worked

```bash
memhouse status
```

Look for a connection check mark, row counts in your rooms, and a recent "last shipped"
time. `memhouse doctor` goes further. It checks the whole pipeline and names anything
skipped.

## 5. Keep it shipping, and open the dashboard

```bash
memhouse start
```

This starts two background daemons. The shipper runs an incremental pass every five
minutes. The dashboard runs at **http://localhost:4640**: sessions, cost by model and
editor, tool calls, and which machine wrote what.

Those daemons do not survive a reboot. To make them permanent:

```bash
memhouse service install      # systemd --user on Linux, a LaunchAgent on macOS
```

## 6. Find something

```bash
memhouse search "connection refused"
```

Each hit names the session, its project and its date. Reopen one:

```bash
memhouse resume claude:6b1f…
#   cd /path/to/project && claude --resume 6b1f…
```

`resume` **prints** the command rather than running it. You see the directory and the id
before anything opens.

## 7. Let your agents remember

```bash
memhouse plugins install claude
```

This installs five skills into every Claude Code config directory it finds. You choose
which ones; all are selected by default. In any Claude Code session afterwards:

```
/mem:recall how did I fix the ClickHouse auth error last month?
```

The agent searches your house, reads the sessions that match, answers from them, and
cites the sessions it used. `/mem:house` reports the state of the house.

## What you have now

- `~/.memhouse/env` holds the connection and both credentials. Never paste it anywhere.
- `~/.memhouse/host.json` holds this machine's identity. Every row it ships carries it.
- A ClickHouse container with your memory in a named volume.

## Undo it

- `memhouse uninstall` stops everything and keeps the house.
- `memhouse deploy --down` removes the container **and its volume**, which **deletes the
  memory**.

See [Uninstall](../guides/uninstall.md).

## Next

- [Tutorial 2](02-join-a-house.md): join a team's house instead of running your own.
- [Configuration](../guides/configuration.md): ship only some editors or directories.
- [How memory is stored](../guides/storage.md): what a room holds, and why nothing is
  ever deleted to make room.
