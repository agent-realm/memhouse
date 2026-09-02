# Working on memhouse

Conventions for any coding agent in this repository — Claude Code, Codex, Gemini CLI,
OpenCode, whatever comes next. `CLAUDE.md` points here; this file is the canonical copy.

Constellation-wide rules (worktrees, branch naming, never pushing to `ramazanpolat/*`)
live in [`~/agent-realm/CLAUDE.md`](../CLAUDE.md) and are not repeated here.

## What memhouse is

A local shipper parses coding-agent sessions from 17 editors and writes them as typed rows
into a ClickHouse database the user owns. A **house** is a database; its **rooms** are
tables (`sessions`, `messages`, `tool_calls`). A **member** owns a house of their own
(`alice.messages`), or — where a database per person is not available — their own rooms in
a shared one (`mem.alice_messages`), granted those and nothing else. A database has ONE
owner or per-member rooms, never both; `roomNames()` in `memhouse/house/house.js` is where
that difference lives, and no other code spells a table name.
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
