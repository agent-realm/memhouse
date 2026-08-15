# resume, update, and a daemon that notices

Three things that were missing, specified together because they share one premise: the
pilot's memory is only useful if they can *get back into* it, and only trustworthy if the
process holding it is the version they installed.

---

## 1. `memhouse resume <session-id>`

### The gap

memhouse was a read-only archive. You could find the session that solved this problem
six weeks ago and not return to it. Every rival that does this is praised for it
(`COMPETITION.md`: Agent Sessions copies resume commands for six CLIs, claude-history
resumes *and* forks worktree-aware).

### What it needs

Nothing new. A stored session already carries both halves:

| Column | Supplies |
|---|---|
| `session_id` | `<source>:<native-id>` — which CLI, and which session in it (`ship.js:575`) |
| `folder` | the directory the session ran in |

So resume is a **read-time computation over two columns**. No schema change, no
migration, no new room.

### It prints; it does not run

The command is written to stdout for the pilot to paste.

Running it would mean guessing a terminal, inheriting this process's cwd, and assuming the
id is still live. When any of those is wrong, the CLI **does not fail** — it opens a new
session. The transcript the pilot asked for is still lost, and the tool reports success.
That is the exact failure shape this repo has been bitten by fifteen times: a wrong answer
delivered confidently.

### The flag table is evidence, not recall

`memhouse/resume.js` holds one entry per resumable editor, and each entry records the date
its syntax was read out of that CLI's own `--help`.

| Source | Command | Read from |
|---|---|---|
| `claude` | `claude --resume <id>` | `claude --help`, 2026-08-12 |
| `codex` | `codex resume <id>` | `codex resume --help`, 2026-08-12 |
| `opencode` | `opencode --session <id>` | `opencode --help`, 2026-08-12 |

**An editor whose flag has not been read that way is absent from the table**, and an absent
entry prints a refusal. Round 10 is why: a field name was asserted from a failed search,
written into a comment, a PR and the task file, and was simply wrong. `goose`, `gemini-cli`
and `cursor-agent` are plausibly resumable and are *not* listed, because they are not
installed on the machine the table was written on.

The refusal distinguishes two cases, for the same reason `discover` separates a skipped
adapter from an editor you do not have:

- **No CLI at all** (`cursor`, `vscode`, `zed`, `kiro`, `copilot-jetbrains`, `antigravity`,
  `devin`, `devin-next`) — nothing takes a session id, and no amount of checking will
  produce something that does. Opening the folder is not resuming the session and is not
  dressed up as it; the folder is printed as the one actionable fact memhouse holds.
- **Unverified** (`goose`, `gemini-cli`, `cursor-agent`, `copilot-cli`, `codebuff`,
  `commandcode`, `gsd`) — a CLI that may well support it; nobody has read the flag yet.

Both sets are **explicit**, and a test derives the full source inventory from `editors/`
and asserts every source lands in exactly one of the three buckets. That test exists because
the same mistake was made twice within a day of each other: `RESUMERS` was first keyed on
`claude` when rows carry `claude-code`, and `windsurf` was listed as a GUI editor when the
adapter emits its VARIANTS ids, `devin` and `devin-next` — so every Devin session fell
through to the *unverified* message, which says the opposite of the truth. A source that
matches nothing must be a test failure, not a default.

And `copilot-cli` was in the GUI set while being, self-evidently, a command line.

### Two more decisions

- **`FINAL` on the read.** `sessions` is a `ReplacingMergeTree`; without `FINAL` a
  re-shipped session can resolve against its older row and print the folder the project
  *used* to live in.
- **Ambiguity refuses.** A bare native id can match more than one source. The command lists
  the matches and exits non-zero rather than picking, because resuming the wrong editor's
  session of the same name is precisely the silent-wrong-answer it exists to prevent.

### Explicitly not built: write-back

Restoring an archived transcript into an editor's own store. Every editor's format is
private and different, and a bad write corrupts the pilot's live history — risking the
original to duplicate the copy.

---

## 2. `memhouse update`

### The gap

`npm i -g memhouse@latest` does half the job, and the other half has cost a real machine
real sessions:

1. **The daemons keep running the old code.** See §3.
2. **The house can be older than the shipper.** A newer shipper may need a column an
   existing room lacks; it detects that and prints the rebuild, but only if something runs
   it.

And from a checkout there is a third: `git pull` updates `ui/src` and leaves the built
bundle in `public/`, so the dashboard serves the previous release however often it is
restarted. A published tarball is immune — `prepack` builds `public/` before publish.

### Install kinds, because the wrong upgrade is not a no-op

| Kind | Detected by | Action |
|---|---|---|
| `global` | under `npm prefix -g` | `npm i -g memhouse@latest` |
| `checkout` | a `.git` at the root | `git pull --ff-only` → `npm install` → `npm run build` |
| `local-dep` | `node_modules/memhouse`, not under the global prefix | refuse; print the right command for where it lives |
| `npx` | `_npx` in the resolved path | refuse — the next `npx` resolves the registry anyway |

Running `npm i -g` from a checkout would install the **published** version over the branch
the pilot was testing. Running `git pull` in a global install does nothing and says it
worked.

### Order of operations

Read the daemon state **first** (`stop` erases the evidence), upgrade, then restart, then
ensure the schema. A failed upgrade restarts nothing and says so — the running version is
left intact rather than half-replaced.

A service-managed shipper is not restarted behind the supervisor's back; the command prints
the supervisor's own restart line.

---

## 3. A daemon that notices

### The gap

Nothing tells a running daemon that its files were replaced. `status` prints the version of
the CLI you just typed, not the version the daemon is executing. On macminim a shipper ran
**1d16h** out of a directory that had been moved.

### Why not `postinstall`

npm blocks install scripts by default — the very condition this product already works
around — so a `postinstall` hook is unreliable exactly where it matters. And a package
install that restarts a user's daemons is a surprise even when it works.

### The mechanism

`memhouse/self-update.js`. Each daemon snapshots at boot: the version **read off disk**
(never `require`d — require caches the first read, which is the value we are trying to
detect a change in), plus the realpath and mtime of its own entry script. Then:

- **shipper** — checks once per loop pass, *after* the sleep and never mid-pass, so an
  upgrade landing during the interval is acted on at the top of the next pass and a
  half-shipped session is never abandoned.
- **dashboard** — has no pass, so it polls on an unref'd 60s timer. It must be covered: the
  static middleware bound to the old `public/` at boot, so its stale bundle is what the
  pilot actually *sees*.

### Two modes, and getting them backwards is expensive

| Mode | Signal | Behaviour |
|---|---|---|
| supervised | `MEMHOUSE_SUPERVISED=1`, written into the unit by `service install` | **exit 0** — the supervisor starts the new version |
| unsupervised | `memhouse start` pidfiles | **re-exec** detached, adopt the pidfile, exit |

A process that re-execs under a supervisor races the unit's own restart, and two shippers
on one house clear each other's rows. A process that merely exits with no supervisor stops
collecting memory entirely.

### Guards

- **Re-exec chains are counted in the environment** (`MEMHOUSE_REEXEC_CHAIN`) and capped at
  3, so a mis-detection cannot spin.
- **A 60s floor** from boot before any handover.
- **The pidfile is only rewritten if it names us.** A daemon started by hand has no pidfile;
  one naming another process belongs to that process, and overwriting it would point
  `memhouse stop` at ours and orphan theirs forever.
- **A vanished entry is reported, not acted on.** If the directory is gone there is nothing
  to exec and no supervisor to resolve a fresh path, so the daemon keeps running and says so
  every pass. A stale daemon still collects sessions; a dead one collects nothing.
