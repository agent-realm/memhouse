# Install and onboard

memhouse is one npm package with no build step and no native dependency. It needs
**Node 24 or newer**. SQLite comes from `node:sqlite`, which is stable in 24. On 22.13+ it
works but prints an `ExperimentalWarning` on every command, and Node 20 is past end of life.

```bash
npm install -g memhouse
```

Then pick the path that matches your situation.

| You have | Run |
|---|---|
| nothing yet, and want the guided route | `memhouse onboard` |
| nothing, but docker or podman | `memhouse deploy --local` |
| an invite file from someone's house | `memhouse install --env invite-<you>.env` |
| a ClickHouse and a member credential | `memhouse install --url … --user … --db mem` |
| a ClickHouse and its admin credential | `memhouse install --url … --admin-user … --member <you>` |
| a ClickHouse someone else administers | `memhouse install --print-sql`, then hand them the SQL |

## `onboard`: the guided route

`memhouse onboard` is interactive:

1. it discovers your editors;
2. it asks where the house is. If none exists and docker or podman is present, it offers
   to run one locally;
3. it ships;
4. it offers to start the daemons and to install the Claude Code skills.

Everything it does can also be done with the scriptable commands below.

## `deploy --local`: a house on this machine

```bash
memhouse deploy --local                     # ClickHouse 25.11 on 127.0.0.1:8123
memhouse deploy --local --house-port 18123  # another port, if 8123 is taken
memhouse deploy --local --tag 26.7          # another ClickHouse version
```

It runs ClickHouse in a container bound to loopback, with the data in a named volume. The
container's superuser is `memhouse_root`, which administers the house. You ship as a
**member** named after your OS user (the command asks; `--user` sets it). The member holds
one grant, on `mem.<you>_*`. Both credentials go into `~/.memhouse/env`, mode 600, so that
inviting someone later needs no flags. It then installs and ships.

The user name and password are fixed when the volume is first initialised and reused on
every redeploy. `memhouse deploy --down` removes the container **and the volume, which
deletes the memory**.

When both docker and podman are installed and one of them cannot answer, choose with
`MEMHOUSE_ENGINE=docker` or `MEMHOUSE_ENGINE=podman`. With rootless podman on Linux, the
container may stop at logout unless lingering is on. `deploy` detects this and prints the
`loginctl enable-linger` command.

## `install`: the scriptable route

```bash
# a member credential you already have
MEMHOUSE_PASSWORD=… memhouse install --url https://house.example.com --user alice --db mem --yes

# from an invite file (the usual way to join a team)
memhouse install --env invite-alice.env

# you hold the server's admin: memhouse creates the member, then ships as the member
with-secret MEMHOUSE_ADMIN_PASSWORD=keychain:pilot/house-admin -- \
  memhouse install --url https://house.example.com --admin-user default --member alice

# you hold nothing: print the SQL for whoever administers the server
memhouse install --print-sql --member alice
```

Useful flags:

| Flag | Effect |
|---|---|
| `--yes` | no questions; take the defaults |
| `--no-ship` | configure and verify, but do not ship yet |
| `--editors claude,codex` | ship only these adapters ([configuration](configuration.md)) |
| `--claude-roots DIR[,DIR]` | ship only these Claude Code config directories |
| `--channel team` | follow this npm dist-tag on `update` |
| `--keep-admin` | keep the admin credential in the env file (not done by default) |
| `--ensure-schema` | create any room or stats table the house is missing |

The admin password never needs to be on the command line. See
[Admin credentials](admin-credentials.md).

`install --env <file>` reads the connection **only** from the file. Exported `MEMHOUSE_*`
variables are ignored, including `MEMHOUSE_EDITORS` and `MEMHOUSE_CLAUDE_ROOTS`. To narrow
what an invite install ships, pass `--editors` / `--claude-roots` as flags.

### What install checks

Before it writes any config, install connects, confirms who the credential is, and checks
that it can reach its rooms. The config is written last, so a refused install leaves no
half-configured machine behind.

Configuration resolves in this order: flags, then exported `MEMHOUSE_*` variables, then
`~/.memhouse/env`. There is no built-in default house. With nothing configured, commands
that read or write memory refuse and say so. They never guess `localhost:8123`, which on
many machines is somebody else's house.

## `EACCES` on install

`sudo` is right for only one of the two causes. What tells them apart is **who owns the
prefix root**, not the path, and not the file npm named.

```bash
ls -ld "$(npm prefix -g)"
```

- **Owned by `root`:** a system-managed Node (distro packages under `/usr`). Re-run with
  `sudo npm install -g memhouse`.
- **Owned by you:** the prefix is yours (Homebrew, fnm, nvm, volta). The root-owned file
  npm tripped on is left over from an earlier `sudo npm`, and another `sudo` adds more.
  Repair just that path: `sudo chown -R "$(id -u):$(id -g)" <the path npm named>`. Do the
  same for `~/.npm` if npm names it.

The path proves nothing on its own: Homebrew's prefix is `/usr/local` on Intel and
`/opt/homebrew` on Apple Silicon, and it is yours in both cases.

## After installing

- `memhouse status`: connection, counts, freshness.
- `memhouse start` or `memhouse service install`: keep shipping. See [Daemons](daemons.md).
- `memhouse plugins install claude`: the `/mem:*` skills. See
  [Search, resume and skills](search-and-resume.md).
