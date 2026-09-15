# Working on memhouse

Conventions for any coding agent in this repository — Claude Code, Codex, Gemini CLI,
OpenCode, whatever comes next. `CLAUDE.md` points here; this file is the canonical copy.

Constellation-wide rules (worktrees, branch naming, never pushing to `ramazanpolat/*`)
live in [`~/agent-realm/CLAUDE.md`](../CLAUDE.md) and are not repeated here.


## Release lines — read before tagging, publishing, or merging a release

memhouse ships two lines to two audiences. They share a repo, not a branch, and nothing
moves between them by itself.

| line | git branch | npm dist-tag | versions | who installs it |
|---|---|---|---|---|
| zeo | `release/0.17` | `latest` | 0.17.x | `npm install -g memhouse` — zeo.memhouse.io members |
| santiment team | `main` (default) | `team` | 0.18.x | `npm install -g memhouse@team` — the one-layout houses |

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
- **One owner per line at a time.** Before releasing, check `ListAgents`/herdr for another
  session on the same repo and agree who cuts it; the release record lives in `CHANGELOG.md`
  on the line's branch and in `drills/`.

## What memhouse is

A local shipper parses coding-agent sessions from 17 editors and writes them as typed rows
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

Version lives in `package.json`, `package-lock.json` and the plugin manifest — all three
move together. `## Unreleased` in `CHANGELOG.md` becomes `## <version> — <date>`. Tag
`v<version>`, push the tag, then publish. A new user-facing capability is a **minor**
bump; so is a behaviour change like refusing a flag that used to be ignored.
