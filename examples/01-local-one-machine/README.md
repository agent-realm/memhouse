# 01 — one machine

The smallest memhouse: one person, one laptop, a ClickHouse in a local container. It shows
the whole loop — a house, a shipping pass, the rows in it, a search that finds a past
conversation — in about a minute.

## What it does

1. `memhouse deploy --local` starts ClickHouse in Docker or Podman, bound to `127.0.0.1`
   only, with a generated password. It creates two accounts: an administrator, and **you**
   as a member who holds `mem.<you>_*` and nothing else. Both credentials go into the
   memhouse home's `env` file (mode 600); nothing is typed or shown.
2. It installs memhouse against that house and starts a background shipper.
3. `memhouse ship` runs one pass in the foreground.
4. `memhouse status` shows what the house holds; `memhouse search` finds a session.

The script ships two made-up sessions from [`../fixtures`](../fixtures/), never yours, and
works in its own home (`~/.memhouse-example-01`), so an install you already have is left
alone.

## Needs

- Node.js 24 or newer, and `npm install -g memhouse`
- Docker or Podman, and port 8123 free (or set `HOUSE_PORT`)
- No earlier `memhouse deploy --local` on this machine. The container and volume names are
  fixed (`memhouse-clickhouse`, `memhouse-data`), so a second local house refuses to start.
  If you have one, you already have this example's result; try [02](../02-existing-clickhouse/).

## Run

```bash
./run.sh
```

| Variable | Default | |
|---|---|---|
| `MEMHOUSE_BIN` | `memhouse` | the command to run, e.g. `node ~/memhouse/bin/memhouse.js` |
| `EXAMPLE_HOME` | `~/.memhouse-example-01` | this example's memhouse home |
| `HOUSE_PORT` | `8123` | the local port ClickHouse binds |

## What you should see

Trimmed from a run on a Linux VM with Docker, ClickHouse 26.7 and memhouse 0.18.9:

```
== 1. a house: ClickHouse in a container, bound to loopback, plus the install
  ✓ ClickHouse starting via docker on http://localhost:8123 (loopback only)
  ✓ ClickHouse ready
  ✓ member 'polat' holds mem.polat_* and nothing else; 'memhouse_root' administers the house
  ✓ rooms for 'polat': polat_sessions, polat_messages, polat_tool_calls
  ✓ installed
  ✓ shipper started in the background (pid 617049) — loading your history now

== 2. one shipping pass
[memhouse] shipped 2 sessions (0 skipped) → 6 msg rows, 2 tool rows in 0.7s

== 3. what the house holds
  ✓ connected: http://localhost:8123 / mem as polat
  ✓ house: 2 sessions, 6 messages (freshest ingest 2026-10-07 21:08:06 UTC)
  ✓ fleet: 1 active writer(s)
     polat@testbed-7edeca38       0.18.9   last ship 0m ago
  ✓ shipper: running — daemon (pid 617049)

== 4. find a past conversation
claude-code:421460e4-5e66-4c1c-afa4-f1b198c28c25  claude-code  alpha  2026-10-07 19:07  (1 hit)
  The deploy fails with ClickHouse error ACCESS_DENIED on INSERT. Why?
```

Three messages per session in the house, not four: the tool result is folded into the
tool call it answers.

To look around, start the dashboard in the example's home (pick another port if 4640 is
taken by a real install):

```bash
MEMHOUSE_HOME=~/.memhouse-example-01 MEMHOUSE_PORT=4641 memhouse start
```

## Teardown

```bash
./run.sh --teardown
```

Stops the shipper (by the pid memhouse recorded), removes the container **and its data
volume**, and deletes the example's home.

## For real

The same thing with your own sessions is two commands, in your default home:

```bash
npm install -g memhouse
memhouse deploy --local
```

Every editor memhouse knows is read (`memhouse discover` lists what it finds first). Then
`memhouse start` for the dashboard and `memhouse plugins install claude` to give your agents
`/mem:recall` and the other skills.
