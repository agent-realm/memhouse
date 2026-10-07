# Working on memhouse

Conventions for any coding agent in this repository — Claude Code, Codex, Gemini CLI,
OpenCode, whatever comes next. `CLAUDE.md` points here; this file is the canonical copy.

Constellation-wide rules (worktrees, branch naming, never pushing to `ramazanpolat/*`)
live in [`~/agent-realm/CLAUDE.md`](../CLAUDE.md) and are not repeated here.


## Release lines — read before tagging, publishing, or merging a release

memhouse shipped two lines while zeo ran the pre-0.18 layout. Since its conversion there
is one line; the rules below are kept because a second line can happen again.

| line | git branch | npm dist-tag | versions | who installs it |
|---|---|---|---|---|
| the one line | `main` (default) | `latest`, and `team` as an alias | 0.18.x | everyone — `npm install -g memhouse` (zeo was converted to the one layout with `memhouse convert`; `release/0.17` is retired) |

Rules, each learned once:

- **Tag on the line's branch, publish from the tag, from the primary checkout.** A 0.17.1 was
  built on `master` (the retired default) and published from a worktree: the branch and the
  registry disagreed for a day, and the package lost its `gitHead`. `misc/publish-guard.js`
  runs as `prepublishOnly` and refuses a publish whose version, `--tag`, branch, or HEAD tag
  disagree with this table. If you need a new line (0.19.x), edit the table **and** the
  guard's `LINES` in the same commit.
- **A fix lands on one line.** Porting to the other is a deliberate merge or cherry-pick with
  its own CHANGELOG entry, never assumed. The one-layout (0.18) renamed every room to
  `<member>_*`; anything touching room names ports with care (`house/HOUSE.md`).
- **`memhouse update` follows the channel a machine was installed from** (`MEMHOUSE_CHANNEL`),
  so a zeo machine never receives a team build by accident, and vice versa.
- **`master` is retired.** It was the pre-0.18 default; `main` is the default now. Do not
  branch from it, tag on it, or push to it.
- **A publish is live when `npm view` says so.** `npm publish` prints `+ memhouse@x.y.z`;
  confirm with `npm view memhouse dist-tags --prefer-online`. A version that seems missing
  right after a publish is registry lag or a stale local npm cache (`npm cache verify`),
  not a "staged" publish. That misdiagnosis cost three releases.
- **Which token.** The pilot's publish token lives in the macOS keychain as `npmjs-token`
  (`~/.pilot-profile/online/npm.md` has the temp-userconfig recipe). Lend it to the one
  command; never print it.
- **One owner per line at a time.** Before releasing, check `ListAgents`/herdr for another
  session on the same repo and agree who cuts it; the release record lives in `CHANGELOG.md`
  on the line's branch and in `drills/`.

## What memhouse is

A local shipper parses coding-agent sessions (16 adapters covering 18 apps) and writes them as typed rows
into a ClickHouse database the user owns. A **house** is a database; its **rooms** are
tables, one set per **member** and named for them (`mem.alice_messages`). A member holds
one grant — `ON mem.alice_*` — and nothing else in the database; nobody is ever granted the
database itself. `roomNames()` in `memhouse/house/house.js` is the only place a table name
is produced, and `memhouse/provision.js` is the only description of what a member is
granted — the live path executes it and `--print-sql` prints it.
The ClickHouse is whichever one the user points at — local container, their own server,
or ClickHouse Cloud; memhouse runs no service of its own and proxies nothing. There is no
LLM anywhere in the write or read path.

`memhouse/DESIGN.md` argues the design. `TERMINOLOGY.md` is the canon for names — if a
thing has a name there, use it and do not invent another.

## The three instruments, and what each cannot see

| instrument | asks | blind to |
|---|---|---|
| `npm test` | is the logic right | anything needing a server |
| `misc/invite-matrix.sh` | does it work against a real ClickHouse | anything a person has to read |
| **a drill** | can someone actually use it | nothing — which is why it is slow |

**[`drills/DRILLS.md`](drills/DRILLS.md) is the drill protocol**, borrowed from
[`kernel`](https://github.com/agent-realm/kernel). A drill is memhouse being used by
agents in real roles who have **not read this repository**. Four things it is easiest to
get wrong:

- **Write a plan first** — roles staffed, and the situation to create.
- **A plan must contain no expected results**, or it is a test that knows the answer.
- **Agents must run where this repo is unreachable**, or they read the source instead of
  reporting the confusion. The installed package's `README.md` and the `/mem:*` skills
  *are* in scope; a real user has those.
- **Never fix memhouse mid-drill**, or the record describes a build that never existed.

Run one after the matrix passes, and before any release that changes a surface a person
touches.

## Things this codebase has learned the hard way

Each of these cost a real incident. They are in the commit log with the measurements.

- **A probe that says yes to everyone is worse than no probe.** `invite` tested
  `SELECT 1 FROM system.users`, which every member passes since they all hold `SHOW USERS`
  — so it announced success and then failed at `CREATE DATABASE`.
- **Scope is part of a privilege.** A member holds `CREATE DATABASE` inside their own
  database and can mint nothing. Match the grant *and* its scope, never the name alone.
- **A flag that is ignored rather than refused** is how a `--dry-run` typo becomes a real
  migration. Every command declares its options in `memhouse/flags.js`.
- **One `data` event is not one keystroke.** Reading a hidden password chunk-at-a-time
  hung forever the moment anyone pasted.
- **Row policies are OR'd, so a permissive catch-all fails open.** A second scoped share
  saw everything. See `memhouse/share.js`.
- **A skill that reasons about privileges in prose gets it wrong.** Put the logic in a
  command and have the skill call it — that is why `memhouse whoami` and `memhouse share`
  exist.
- **Never print a credential.** memhouse ships this transcript into the house being
  administered, and the archive is insert-only. Expand a shell variable; never a literal.

## Testing before you claim it works

```bash
npm test                                            # syntax gate + unit checks
misc/invite-matrix.sh <url> <admin-user> <password> # against a real ClickHouse
misc/origin-matrix.sh …                             # the import/ship data guarantees
memhouse nightly --out /tmp                         # a real installable tarball
```

`node bin/memhouse.js` from a checkout is **not** the product — the files are laid out
differently and the design is sitting next to it. Anything about installation, first run,
or what a user sees must be verified from a built package on a machine without a checkout.

CI runs `npm test`, both matrices and a headless e2e across ClickHouse 25.11 and 26.7, on
ubuntu only. macOS and Windows are untested there; say so rather than implying coverage.

## Releasing

Version lives in `package.json`, `package-lock.json` and the plugin manifest
(`memhouse/delivery/plugin/.claude-plugin/plugin.json`). All three move together, along
with the memhouse.io badges. `## Unreleased` in `CHANGELOG.md` becomes
`## <version> — <date>`. Tag `v<version>`, push the tag, then publish. A new user-facing
capability is a **minor** bump; so is a behaviour change like refusing a flag that used
to be ignored.

Every release also has:

- **A release document**, `docs/releases/v<version>.md`: what changed, what a user must
  do, the upgrade steps, deprecations with their removal version, and what was deferred.
  The CHANGELOG entry links to it, and the GitHub release uses it as its notes
  (`gh release create v<version> --notes-file docs/releases/v<version>.md`).
- **The documentation standard:**
  - a short README (what, why, how);
  - `docs/`, with tutorials and guides for common operations;
  - `examples/`, from smallest to full, each with its own README;
  - the agent install section below.

  A change to a command, a flag or a default updates the guide that describes it in the
  same PR.
- **A drill** when the release changes a surface a person touches (see above), recorded
  in `drills/`.

## Installing and deploying memhouse (for agents)

How an agent installs memhouse for its principal, unattended. Every command takes `--yes`
and most take `--json`. Follow the first route that applies, and never invent a house.

```bash
npm install -g memhouse                       # Node 24+. Distro Node: sudo. Homebrew/nvm/fnm/volta: no sudo

# 1. The principal handed you an invite file:
memhouse install --env invite-<name>.env --yes          # rotates the password, deletes the file

# 2. The principal has a member credential, held by a secret manager:
with-secret MEMHOUSE_PASSWORD=<reference> -- \
  memhouse install --url <url> --user <member> --db mem --yes

# 3. The principal administers the server (creates the member, ships as the member):
with-secret MEMHOUSE_ADMIN_PASSWORD=<reference> -- \
  memhouse install --url <url> --admin-user <admin> --member <name> --yes

# 4. Nothing exists yet, and docker or podman is present: a house on this machine
memhouse deploy --local --yes

# Then verify, and keep it running:
memhouse status --json        # connection, rooms, last pass
memhouse whoami --json        # which credential, and what it may do
memhouse service install      # survive reboots
memhouse plugins install claude --yes
```

`memhouse prompt --install` prints an install prompt rendered for the current machine,
with its state and the one route that applies.

Rules:

- **Never put a secret in the conversation, in argv, or in a file you write.** memhouse
  ships transcripts into the house, and the archive is insert-only. Take passwords by
  reference (`with-secret`, `MEMHOUSE_ADMIN_PASSWORD`, `--admin-password-file -`). Never
  print `~/.memhouse/env`. If a secret reaches a transcript, say so and recommend rotation.
- **Never guess a house.** With no URL from the principal and no invite file, stop and ask.
  Do not point at `localhost:8123` because something answers there.
- **Destructive commands need the principal's explicit yes, for that object:**
  `memhouse reset`, `deploy --down` (deletes the local house's data),
  `uninstall --full-removal`, and any `DROP`/`DELETE` in SQL. Look first, report the
  counts, then ask.
- **Verify from the outside.** `status --json` and a row count in `mem.<member>_messages`
  are the evidence that it works. A started daemon is not.

The user-facing version of all this is in [`docs/guides/install.md`](docs/guides/install.md).
