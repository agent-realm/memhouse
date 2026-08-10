# memhouse — agent install

Imperative steps for an AI coding agent installing memhouse on a machine. Execute
in order; every command is copy-pasteable.

**Prefer `memhouse prompt --install`.** It renders `AGENT-INSTALL-PROMPT.md` against the
machine it runs on — which editors have sessions, whether a ClickHouse answers, whether
docker or podman exists — and states the one route that applies. This file is the static
long-form version and assumes a reachable ClickHouse already exists, which is the case
`deploy --local` was added to remove. Prereqs: Node >= 20.19 and a reachable
ClickHouse >= 26.2 (local server, Cloud, or a kernel house — see
`kernel-install.md` for the kernel path). No checkout required — memhouse is on npm.

## 1. Install

```bash
npm install -g memhouse --allow-scripts=better-sqlite3
```

`--allow-scripts=better-sqlite3` is required, not cosmetic. Five adapters (cursor,
goose, opencode, zed, antigravity) read SQLite session stores, and npm 12 blocks
the install script that builds the native binding. Without it those five silently
return zero sessions and you ship a partial history. Verify with step 4 —
`memhouse discover` names any adapter it had to skip.

On `EACCES`, decide by **who owns the prefix root**. Not the path — Homebrew's
prefix is `/usr/local` on Intel and `/opt/homebrew` on Apple Silicon and is
user-owned in both. Not the failing file either — an earlier `sudo npm` leaves
root-owned files inside a prefix that is still the user's, and judging by those
misreads it as system-managed.

```bash
ls -ld "$(npm prefix -g)"     # the prefix ROOT decides
```

Prefix root owned by `root` → a system-managed Node; re-run as
`sudo npm install -g memhouse --allow-scripts=better-sqlite3`.

Prefix root owned by the current user → the prefix is theirs (Homebrew, fnm, nvm,
volta), so the root-owned file npm tripped on is a stray from an earlier `sudo npm`
and another `sudo` adds more. Repair that path instead:
`sudo chown -R "$(id -u):$(id -g)" <path npm named>` (same for `~/.npm`).

From a checkout instead (contributors): `npm install --no-audit --no-fund` in the
repo root — its `allowScripts` field already covers the binding — then substitute
`node bin/memhouse.js` for `memhouse` below.

## 2. Configure the connection

Write `~/.memhouse/env` (or run `memhouse install --yes --url … --user … --password
… --db …`, which writes it for you):

```bash
mkdir -p ~/.memhouse
cat > ~/.memhouse/env <<'EOF'
MEMHOUSE_URL=http://localhost:8123
MEMHOUSE_USER=memhouse_root
MEMHOUSE_PASSWORD=<credential>
MEMHOUSE_DB=mem
EOF
chmod 600 ~/.memhouse/env
```

## 3. Create the schema and run the first ship

```bash
memhouse install --yes     # applies the schema, then runs the first full ship
```

Expected output shape: `[memhouse] shipped N sessions (0 skipped) → M msg rows, T
tool rows in Xs` with N in the hundreds on a machine with real agent usage.

## 4. Verify

```bash
memhouse discover     # which adapters were read, and which were SKIPPED
memhouse stats        # per-source counts now in the house
```

Read `discover` first. It prints one line per editor it found sessions for, and
warns by name about any adapter it had to skip — that warning is the only signal
that step 1's `--allow-scripts` flag was missed and five editors are dark.

`stats` should show one row per source (claude-code, codex, gemini-cli, …) with
non-zero sessions/messages. Or verify by SQL — rooms are named for your ClickHouse
user, and the session rollup is a saved query rather than an object, so
`memhouse sessions-query` prints it:

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

Installs the memhouse plugin into `<claude-config>/skills/memhouse`, which loads next
session as `memhouse@skills-dir` and exposes `/memhouse:search`, `/memhouse:sessions`
and `/memhouse:sql`. They read the connection from `$MEMHOUSE_HOME/env` (default
`~/.memhouse/env`), with exported `MEMHOUSE_*` vars taking precedence, and refuse to run
rather than guessing a URL when neither is set. `memhouse plugins list` shows what is
installed, `memhouse plugins remove claude` undoes it.
