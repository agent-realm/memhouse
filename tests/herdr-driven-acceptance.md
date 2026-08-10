# herdr-driven acceptance test

You are testing **memhouse** the way a person would: by typing into a terminal and
reading what comes back. Not by importing modules and asserting on return values.

Everything below runs against a throwaway ClickHouse and a herdr workspace you create
and destroy. **Nothing touches the pilot's own house, config, or daemons.**

## Why this exists

memhouse's worst defects have all been the same shape: the code was right and the
*experience* was broken. A guard whose own advice was blocked. A shipper that deleted
rows nobody asked it to delete. An install prompt that asked for a URL right after
proving there was nothing to point at. Unit tests passed through every one of them.

So: drive it like a human, read the output like a human, and believe the output over
the source.

## Before you start

- You are running **inside herdr** (`$HERDR_ENV` is `1`). Nested herdr is disabled, so
  you drive the *existing* instance — do not try to launch one.
- Read `/Users/polat/.claude/skills/herdr/SKILL.md` for the command surface.
- Read `memhouse/per-member/INSTALL.md` — it states the three install paths and every
  refusal. That document is the contract you are testing.
- Have the branch under test checked out in a worktree. Do not test the pilot's
  primary checkout.

## Ground rules

1. **Never point at `localhost:8123` or `localhost:18999`.** Those are the pilot's
   real houses. Use only the lab endpoint you create. If a memhouse command ever
   connects to 8123, that is a finding — as of 0.4.5 nothing should fall back there.
2. **Always set `MEMHOUSE_HOME`** to a temp dir for every command. Without it you
   overwrite `~/.memhouse/env`. Put that dir under `/private/tmp/mh-acc-<you>/`, NOT in
   the shared scratchpad — parallel agents have deleted each other's config there.
3. **Read output before deciding.** `herdr pane read` after every step. A command that
   printed an error and exited 0 is still a failure.
4. **Record what you did not test.** A gap you name is worth more than a pass you
   assumed.
5. **Clean up even if you fail** — `lab down`, `herdr workspace close`, temp dirs.

---

## Phase 1 — an isolated house

Spin a lab ClickHouse. **Do not assume the port** — `lab up` prints `PORT_BASE` and it
is whatever block is free, not the one you expected. Read it back from `lab ls`.

```bash
cat > /tmp/ch-test.yml <<'YML'
services:
  clickhouse:
    image: clickhouse/clickhouse-server:26.7
    environment:
      CLICKHOUSE_USER: memhouse_root
      CLICKHOUSE_PASSWORD: labpw
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1"
    ulimits:
      nofile: {soft: 262144, hard: 262144}
    ports: ["${PORT_BASE}:8123"]
YML
lab up mh-acceptance --compose /tmp/ch-test.yml     # prints PORT_BASE — capture it
lab ls                                              # confirm the port
lab tunnel start                                    # if not already up
```

Poll until it answers; do not sleep blindly:

```bash
until curl -s -m 3 -u memhouse_root:labpw --data-binary "SELECT 1" \
  http://localhost:<PORT>/ | grep -q 1; do sleep 4; done
```

Run the same suite against **26.7 and 25.11**. They differ in ways that have bitten
before: 25.11 rejects `ALTER` on tables carrying the messages text indexes unless
`allow_experimental_full_text_index` is set, even for an unrelated `ADD COLUMN`.

## Phase 2 — a workspace and a tab

```bash
herdr workspace create --cwd <worktree> --label "memhouse acceptance"   # note the id
herdr tab create --workspace <ws> --label "cli"
herdr pane list                                                        # get the pane id
```

From here, every command goes through the pane. That is the point — you are testing
what a person sees, including prompts, colours, and whether a refusal is legible.

```bash
herdr pane run <pane> "<command>"
herdr pane wait-output <pane> --match "<expected>" --timeout 60000
herdr pane read <pane> --source visible --lines 40
```

There is no `herdr wait output` — the command is `herdr pane wait-output`. And on a
freshly-created pane `--source recent` returns empty; use `--source visible`.

If `wait-output` times out, **read the pane and report what was actually there**.
A timeout is a finding, not a retry cue.

## Phase 3 — install, all three paths

`INSTALL.md` defines three. Test each on a *fresh* database (`--db` a new name, or
drop it between runs).

| Path | Command | Must end with |
|---|---|---|
| admin bootstrap | `install --admin-user … --admin-password … --member <m> --member-password …` | member created, **reconnect verified as the member**, admin credential NOT in the env file |
| member credential | `install --url … --user … --password …` | rooms found or created, config written |
| print the SQL | `install --print-sql --member <m>` | SQL printed, **nothing contacted, nothing written** |

For `--print-sql`, actually **run what it printed** — one statement per HTTP request
(the interface refuses multi-statement bodies; there is no setting that changes that).
Then install as the member against the house it built. The advice is the deliverable,
not the guard.

Check after the admin path:

```bash
grep MEMHOUSE_USER $MEMHOUSE_HOME/env      # must be the MEMBER, never the admin
grep -c "<admin-password>" $MEMHOUSE_HOME/env   # must be 0
```

## Phase 4 — every refusal

These are the contract. Each must refuse, name both sides, and **change nothing**.
Verify the "change nothing" half by counting rows before and after.

- install twice with the same `--member` → refuses (identity takeover), unless
  `--adopt-user` **and** `--member-password`, which it verifies by reconnecting
- `--adopt-user` with the wrong password → refuses
- a handle starting with a digit, or `root` → refuses
- an env file pointing at a different url/db → refuses, unless `--force`
- a member with no `CREATE TABLE` and no rooms → refuses, prints the owner's command
- a pre-0.4.4 house (transcript rooms without `origin` in the sorting key) → **the
  shipper refuses and prints the rebuild**. Build one by creating rooms from the
  template with the `origin` line stripped and the ORDER BY reverted.
- a 0.4.4 house (`origin` wrongly in the SESSIONS sorting key) → same refusal. Build one
  by adding `origin` back into the sessions ORDER BY. Both directions are wrong and both
  must be caught.
- **no config at all** — unset every `MEMHOUSE_*` and point `MEMHOUSE_HOME` at an empty
  dir, then run `ship`, `search`, `stats`, `status`, `start`, `reset`. Each must refuse
  and name the fix. **None may connect to `localhost:8123`.** This is the one that
  silently sent an acceptance agent at the pilot's real house.

## Phase 5 — the data guarantees

Run `misc/origin-matrix.sh <label> <url> <user> <pass>` — 14 checks covering the
import/ship split. It must be 14/14 on **both** ClickHouse versions.

Then the same thing through the CLI, which the matrix does not cover:

1. Install and ship. Note the counts.
2. Insert rows with `origin='import'` directly (simulating migrated history).
3. `memhouse ship` again.
4. **The `origin='import'` count must not move.** This is the 0.4.4 guarantee and the
   single most expensive bug this product has had — one pass destroyed 27,948 messages.
5. Ship a third time and confirm the incremental skip works: the second pass should
   report most sessions **skipped**, not re-shipped. A pass that re-ships everything
   is a regression even though no data is lost.
6. **Skip must survive imported rows.** Add one `origin='import'` row to a session that
   has already settled into `skipped`, then ship twice more. It must stay skipped. Before
   0.4.5 the skip compared `count()` against `message_count`, so a single imported row
   made that session re-ship forever.
7. **One session row, always.** `SELECT session_id, count() FROM sessions_<m> FINAL GROUP
   BY session_id HAVING count() > 1` must return nothing, including for sessions that
   carry imported rows. Two rows double every metric the rollup computes.
8. **Real timestamps.** Ship a Claude Code session whose JSONL has known per-message
   timestamps. The stored `ts` must match them, not be spread evenly between the
   session's first and last time.

## Phase 6 — every other command

Drive each through the pane and read the result. Do not accept exit 0 as a pass.

```
discover      names editors with sessions, and any adapter skipped for a missing
              native binding — install WITHOUT --allow-scripts=better-sqlite3 once
              and confirm it names the six SQLite adapters rather than silently
              reporting zero
doctor        every line a check mark on a healthy house; on a broken one, the
              failing line must name the fix
status        counts and freshness; --json parses
search        returns a hit from data you shipped
stats         per-source totals that match the house
ship --full   re-ships everything, imported rows still intact
start / stop  daemons appear and disappear; dashboard answers on the port
service       install / status / uninstall; on Linux check the lingering warning
deploy        --local stands a house up; --down removes container AND volume
reset         truncates and re-ships (destructive — lab only)
uninstall     removes config, leaves the house
prompt        prints the memory snippet
prompt --install   renders THIS machine's state and picks one route, not a decision tree
plugins install claude   writes the three skills
```

## Phase 7 — the Claude Code plugin

This is the half that unit tests cannot reach at all.

Install the plugin, then open a **claude-code instance in its own herdr tab** and use
it as a person would.

```bash
herdr tab create --workspace <ws> --label "claude"
herdr pane run <pane2> "cd <worktree> && claude"
herdr pane wait-output <pane2> --match ">" --timeout 60000
```

The skills are **`/memhouse:search`, `/memhouse:sessions`, `/memhouse:sql`**. The colon
namespace is earned by being installed as a plugin — `<config>/skills/memhouse/` holding
`.claude-plugin/plugin.json` plus `skills/{search,sessions,sql}/`. If autocomplete offers
`/memhouse-search` with a hyphen instead, the installer regressed to copying loose skill
directories; that is a defect, not a naming variant. Check `plugins list` and the
installed tree before reporting anything else about the skills.

`/mem:ask` and `/mem:search` belonged to *memory-house*, which was removed from this
machine on 2026-08-09. They should not resolve at all.

Drive them by sending text, as a human would:

```bash
herdr pane send-text <pane2> "/memhouse:search clickhouse"
herdr pane send-keys  <pane2> Enter
herdr pane wait-output <pane2> --match "sessions|hits|no results" --regex --timeout 120000
herdr pane read <pane2> --source visible --lines 60
```

What must hold:

- the skill finds sessions you shipped in phase 5 — content you can predict
- room names are **suffixed** (`messages_<member>`); if the agent writes `FROM messages`
  it gets `UNKNOWN_TABLE`, and the skill doc is what should have stopped it
- `/memhouse:sql` runs read-only SQL and refuses writes
- the session rollup is a **saved query**, not an object — an agent that does
  `FROM sessions_v` is following stale instructions
- credentials never appear in the transcript

Then uninstall the plugin and confirm the skills are gone.

## Phase 8 — uninstall and teardown

```bash
memhouse uninstall            # config gone, house untouched — verify both
npm rm -g memhouse            # if you installed globally
lab down mh-acceptance
herdr workspace close <ws>
rm -rf $MEMHOUSE_HOME /tmp/ch-test.yml
```

Confirm the house still holds its rows after `uninstall` — that is the documented
contract ("the house data in ClickHouse is untouched").

---

## Reporting

Write a table: check, expected, observed, pass/fail. Then:

- **every failure with the exact output**, not a paraphrase
- **what you could not test and why** — a missing container engine, an unreachable
  lab, a step that needs credentials you do not have. Name it; do not skip silently.
- **anything that passed but read badly** — a refusal that does not say what to do
  next, a message naming a path that does not exist, a prompt asking for something
  the tool already knows. Those are the defects this suite exists to catch, and they
  do not show up as a failed assertion.

A run that finds nothing is a suspicious run. The last four times this product was
driven end to end, each pass found a defect the tests had missed.

## Known-unavailable

`agent-gauntlet` cannot drive this yet. Its engine still renders memory-house's step
vocabulary verbatim — it tells the agent to install "memory-house as a plugin from
~/memhouse (plugin/install.sh)" and to run `mh run`, neither of which exists here. A
gauntlet run today measures the engine's defaults, not memhouse. Making the drive step
subject-parameterised is a change in `agent-gauntlet`, not here. Until then this suite
is herdr + lab, and `testbed` when you need a real machine to install onto.
