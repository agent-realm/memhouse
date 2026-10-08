# Configuration

Everything memhouse needs is in one env file, `~/.memhouse/env` (mode 600), or in the
directory named by `MEMHOUSE_HOME`. Values resolve in this order:

1. command-line flags;
2. exported `MEMHOUSE_*` variables;
3. `$MEMHOUSE_HOME/env`.

With nothing configured, commands that touch the house refuse and say so. There is no
default house.

| Variable | Meaning |
|---|---|
| `MEMHOUSE_URL` | the house's HTTP(S) endpoint |
| `MEMHOUSE_USER` / `MEMHOUSE_PASSWORD` | the member credential the shipper writes as |
| `MEMHOUSE_DB` | the database holding the rooms, normally `mem` |
| `MEMHOUSE_PORT` | the dashboard port, default `4640` |
| `MEMHOUSE_CHANNEL` | the npm dist-tag `update` follows |
| `MEMHOUSE_EDITORS` | which adapters run (default: all) |
| `MEMHOUSE_<EDITOR>_ROOTS` | where one adapter looks |
| `MEMHOUSE_HOME` | where the env file, host identity, logs and pidfiles live |
| `MEMHOUSE_ENGINE` | `docker` or `podman`, for `deploy --local` |

Never print this file or these variables in a terminal an agent is reading. memhouse ships
transcripts, and a password that appears in one is in the archive.

## Which sessions ship

By default, everything on the machine: every adapter, from wherever that editor keeps its
sessions. `memhouse discover` prints what each adapter watches and the variable that moves
it:

```
Watched directories (override with the variable shown, in the env file):
    claude       ~/.claude, ~/.claude-playbooks/kommander, …   [MEMHOUSE_CLAUDE_ROOTS]
    codex        ~/.codex                                      [MEMHOUSE_CODEX_ROOTS]
    gemini-cli   ~/.gemini                                     [MEMHOUSE_GEMINI_CLI_ROOTS]
    cursor       ~/Library/Application Support/Cursor/User, …  [built-in]
```

Two kinds of line in the env file narrow it, or `--editors` / `--claude-roots` at install:

```
MEMHOUSE_EDITORS='claude'
MEMHOUSE_CLAUDE_ROOTS='~/.claude-playbooks/kommander-chaos'
```

- `MEMHOUSE_EDITORS` names the adapters to run.
- `MEMHOUSE_<EDITOR>_ROOTS` replaces one adapter's location. The variable name is the
  adapter's name upper-cased, with dashes turned into underscores.
- Claude is the one adapter with many roots, one per Claude Code config directory, so its
  list may hold several. Every other adapter has one store and takes one path.
- Adapters marked `[built-in]` resolve a platform app-data directory and cannot be moved
  yet.

An adapter name or a directory that does not exist is refused and reported against that
adapter. It is never shipped from the default instead: a typo that quietly shipped
nothing would look like a working install with an empty house.

Restart the shipper after changing these (`memhouse stop && memhouse start`, or
`memhouse service restart`).

## Instances: several memhouses on one machine

An **instance** is a home. It has:

- an env file naming a house;
- the daemons shipping to that house;
- the playbooks whose sessions it ships (`MEMHOUSE_CLAUDE_ROOTS`).

A machine can run several, each under its own `MEMHOUSE_HOME` and on its own channel:

```bash
MEMHOUSE_HOME=~/.memhouse-work memhouse install --env invite-work.env
MEMHOUSE_HOME=~/.memhouse-work memhouse instance    # which memhouse this is
```

`memhouse instance` prints one screen:

- the instance's name and home;
- the binary and its channel;
- the house, its database and member, and whether an admin credential is present;
- the rooms, with row counts;
- what this machine ships;
- the host identity;
- the daemons;
- which playbooks are bound to this instance.

`plugins install claude`, run from an instance, installs the skills into exactly the
playbooks that instance ships, and **binds** them. It writes `MEMHOUSE_HOME` and
`MEMHOUSE_BIN` into each playbook's `settings.json` `env`, and Claude Code applies that to
every session there. So the `/mem:*` skills in a bound playbook read that instance's house
and run that instance's binary, whatever the launching shell had set. `plugins list` shows
the binding; `plugins remove claude` takes it out.

## Channels

`memhouse update` follows the npm dist-tag the install came from, not `latest` by reflex.

- The channel is inferred from the installed version.
- To pin it, add `MEMHOUSE_CHANNEL='team'` to the env file, or run
  `memhouse update --channel team`, which writes the same line.
- An invite from a house on a channel carries that channel, so the invitee follows it
  too.
- A tarball or checkout build sits on no tag and is never auto-updated. `update --check`
  says so.

Today there is one release line: `latest`, with `team` as an alias for the same build.
