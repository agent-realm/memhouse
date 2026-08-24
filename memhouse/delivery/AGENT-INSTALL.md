# memhouse — agent install

Imperative steps for an AI coding agent installing memhouse on a machine. Execute
in order; every command is copy-pasteable.

**Prefer `memhouse prompt --install`.** It renders `AGENT-INSTALL-PROMPT.md` against the
machine it runs on — which editors have sessions, whether a ClickHouse answers, whether
docker or podman exists — and states the one route that applies. This file is the static
long-form version and assumes a reachable ClickHouse already exists, which is the case
`deploy --local` was added to remove. Prereqs: Node >= 24 and a reachable
ClickHouse >= 26.2 (local server, Cloud, or a kernel house — see
`kernel-install.md` for the kernel path). No checkout required — memhouse is on npm.

## 1. Install

```bash
npm install -g memhouse
```

No flags. This line used to require `--allow-scripts=better-sqlite3`, without which
five adapters (cursor, goose, opencode, zed, antigravity) silently returned zero
sessions and you shipped a partial history. SQLite now comes from `node:sqlite`, which
is part of Node, so there is no install script and nothing to allow. Step 4 still
verifies — `memhouse discover` names any adapter it had to skip, for any reason.

On `EACCES`, decide by **who owns the prefix root**. Not the path — Homebrew's
prefix is `/usr/local` on Intel and `/opt/homebrew` on Apple Silicon and is
user-owned in both. Not the failing file either — an earlier `sudo npm` leaves
root-owned files inside a prefix that is still the user's, and judging by those
misreads it as system-managed.

```bash
ls -ld "$(npm prefix -g)"     # the prefix ROOT decides
```

Prefix root owned by `root` → a system-managed Node; re-run as
`sudo npm install -g memhouse`.

Prefix root owned by the current user → the prefix is theirs (Homebrew, fnm, nvm,
volta), so the root-owned file npm tripped on is a stray from an earlier `sudo npm`
and another `sudo` adds more. Repair that path instead:
`sudo chown -R "$(id -u):$(id -g)" <path npm named>` (same for `~/.npm`).

From a checkout instead (contributors): `npm install --no-audit --no-fund` in the
repo root — nothing compiles — then substitute `node bin/memhouse.js` for `memhouse`
below.

## 2 + 3. Configure, create the schema, first ship — one command

Do NOT hand-write `~/.memhouse/env`. `install` validates the connection, builds the
rooms, ships, and writes the config LAST — a hand-written file is read as truth by
every later command even when it is wrong, and an example URL pasted verbatim points
at somebody's real house.

With a credential the user already has on the house:

```bash
memhouse install --url <house-url> --user <member> --password '<credential>' --db <house>
```

Or, holding an admin credential, mint the member and the house in one go:

```bash
memhouse install --url <house-url> \
  --admin-user <admin> --admin-password '<admin-credential>' \
  --db <house> --member <member> --member-password '<credential>'
```

The admin credential is used once and never stored. Ask the user for values; never
invent them and never default to localhost:8123 — on many machines that is a real house
belonging to someone else.

Expected output shape: `[memhouse] shipped N sessions (0 skipped) → M msg rows, T
tool rows in Xs` with N in the hundreds on a machine with real agent usage.

## 4. Verify

```bash
memhouse discover     # which adapters were read, and which were SKIPPED
memhouse stats        # per-source counts now in the house
```

Read `discover` first. It prints one line per editor it found sessions for, and warns
by name about any adapter it had to skip. On a healthy install that list is empty: the
one cause that could take five adapters out at once — a missing native SQLite binding —
no longer exists, so anything named here is a single editor's own store (locked by a
running editor, corrupt, or on a schema this parser does not know).

`stats` should show one row per source (claude-code, codex, gemini-cli, …) with
non-zero sessions/messages. Or verify by SQL — the rooms are plain shared tables
(`sessions`, `messages`, `tool_calls`) and the session rollup is a saved query rather
than an object, so `memhouse sessions-query` prints it (it also applies the
current-parse filter that any hand-written read of `messages` needs — the shipper
retains superseded parses under an `epoch`):

```bash
curl -s -u "$MEMHOUSE_USER:$MEMHOUSE_PASSWORD" "$MEMHOUSE_URL/?database=$MEMHOUSE_DB" \
  --data-binary "SELECT source, count() FROM $(memhouse sessions-query) AS c GROUP BY source SETTINGS final=1, join_use_nulls=1 FORMAT PrettyCompact"
```

## 5. Start the dashboard and the shipper loop

```bash
memhouse start        # both as background daemons; UI is prebuilt in the package
memhouse status       # daemons, connection, counts, freshness (--json for agents)
```

The dashboard comes up on http://localhost:4640. `start` also runs the incremental
re-ship loop, so this replaces any separate cron. `memhouse stop` ends both.

## 6. Install the skills (optional, for Claude Code)

```bash
memhouse plugins install claude
```

Installs the memhouse plugin into `<claude-config>/skills/mem`, which loads next
session as `mem@skills-dir` and exposes `/mem:recall`, `/mem:sql`, `/mem:house`,
`/mem:access` and `/mem:admin`. They read the connection from
`$MEMHOUSE_HOME/env` (default
`~/.memhouse/env`), with exported `MEMHOUSE_*` vars taking precedence, and refuse to run
rather than guessing a URL when neither is set. `memhouse plugins list` shows what is
installed, `memhouse plugins remove claude` undoes it.

## 7. Upgrading a machine that already ran memhouse < 0.10

The 0.10 schema changed the transcript tables' sorting keys, so the first `ship` against
an old house refuses and names the fix. Run it:

```bash
memhouse migrate      # copies each room, swaps atomically, keeps <room>_pre_epoch
```

Nothing is deleted; a service-managed shipper resumes on its next pass by itself.
`memhouse update` performs this for the user interactively (`--migrate` runs it
unasked); as an agent, prefer `memhouse update --no-install --migrate` after an
`npm install -g` you already performed. If OTHER machines still ship into the same
house with an older memhouse, tell the user to upgrade them promptly — the migration
output explains why and prints the admin-side alternative.
