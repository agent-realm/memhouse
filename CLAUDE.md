# memhouse — agent instructions

**The conventions for this repository live in [`AGENTS.md`](AGENTS.md). Read that.**

It is kept vendor-neutral so Codex, Gemini CLI and anything else obey the same rules; this
file exists only so Claude Code finds it. Nothing here overrides it.

Two things worth knowing before your first change:

- **[`drills/DRILLS.md`](drills/DRILLS.md)** — a drill is memhouse being *used* by agents
  who have not read this repository. It is the only instrument that catches what `npm test`
  and the matrices structurally cannot, and four defects shipped because nobody ran one.
- **`AGENTS.md` § "Things this codebase has learned the hard way"** — each entry cost a
  real incident. Read it before touching privileges, flags, credentials, or row policies.

Constellation-wide rules — worktrees, `<agent>/<description>` branch names, never pushing
to `ramazanpolat/*` — are in [`~/agent-realm/CLAUDE.md`](../CLAUDE.md).
