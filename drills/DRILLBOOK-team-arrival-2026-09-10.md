# Drillbook — team arrival: N invitees join one house through their playbook

The repeatable script for the drill that gates a `team` release. It stages a real house, a
real operator (TART), and simulated pilots on real machines who receive an invitation and
join by handing the guide to their own playbook's agent. Everything here was learned by
running it; the pitfalls at the end each cost real time on 2026-09-10.

## Cast

| seat | who | where |
|---|---|---|
| house | ClickHouse **pinned to the version the team runs** (santiment: 25.8) | `lab up <name> --compose <copy of examples/clickhouse-realm.yml with the image pinned>` |
| operator | TART, from the operator's machine, with the **0.18 binary** (`node ~/agent-realm/memhouse/bin/memhouse.js`, never the global 0.17) | a scratch `MEMHOUSE_HOME` whose env pins `MEMHOUSE_CHANNEL='team'` and holds the admin credential |
| pilots | one per playbook flavour, **two `chaos` + two `chaos-santiment`** | testbed actors (`testbed` 106, `testbed-rpolat` 108, more via `bin/new-actor.sh`) |
| cockpit | a herdr workspace, **one tab per pilot** plus an `operator` tab | `herdr workspace create --label memhouse-drill` |

## Stage

1. **House.** `lab up drill258 --compose <pinned compose>`; create `memhouse_root` with a
   generated password kept in a scratch file, never printed; `GRANT CURRENT GRANTS ON *.*
   … WITH GRANT OPTION` (a bare `GRANT ALL` fails on 26.x over missing
   `SHOW NAMED COLLECTIONS SECRETS`).
2. **Operator home.** Scratch dir with `env`: URL, `MEMHOUSE_DB='mem'`,
   `MEMHOUSE_CHANNEL='team'`, `MEMHOUSE_ADMIN_USER/PASSWORD`. The channel matters: it is
   what makes the invitee's guide say `npm install -g memhouse@team`.
3. **Invitations.** `memhouse invite <name> --url http://<lab-ip>:<port> --out
   <inbox-name>/invite-<name>.env` per pilot. Check the guide says `@team` and has step 0.
4. **Pilot machines, clean.** Do NOT rely on `rollback-synced.sh` if the snapshot's
   credentials are old (July creds may be expired; yesterday's live creds work). Clean by
   hand: stop shippers (`pgrep -f "[s]hipper/ship.js"` — the bracket keeps `pkill -f` from
   killing the ssh shell that contains the pattern), `npm uninstall -g memhouse`, remove
   `~/.memhouse*`, `~/.mh-*`, stray `~/Downloads/*.env`, old inboxes.
5. **Playbook.** rsync the playbook content only — exclude `.git`, `.credentials.json`,
   `.claude.json`, `projects/`, `data/`, `todos/`, `history.jsonl`, `shell-snapshots`,
   `statsig`, `sessions`, `plugins`, and **`skills/mem`** (a pre-installed old `/mem` would
   defeat the test; the invitee installs it). Copy the VM's own `~/.claude/.credentials.json`
   and `~/.claude.json` into the config dir. Verify `skills/mem` is absent afterwards; an
   rsync exclude that silently misses is how a stale 0.17 plugin got on both VMs.
6. **Launcher.** The playbook's `install.sh` writes a zsh alias; the VMs are bash. Write
   `/usr/local/bin/<playbook>`: `PATH="$D/bin:$PATH" CHAOS_NAME=<name> CLAUDE_CONFIG_DIR="$D"
   exec claude --permission-mode auto --effort max "$@"` — mirror the alias body exactly.
7. **Inbox.** `~/inbox/` on each VM with the two files, mode 600.
8. **Cockpit.** One herdr tab per pilot: `ssh -t <vm> 'cd ~/inbox && exec bash -l'`.
   Operator tab: a 30s loop as admin listing members and `mem.*` row counts. Send pane
   commands **once**, after the shell is up; a second `pane run` types into whatever is
   already running (it started a nested ssh in a pilot's shell once).

## Run, per pilot

The person types, in their tab: `<playbook> "Read MEMHOUSE-INVITATION.md in this directory
and follow it to the end. I authorize every step; do not stop to ask."` Then the person
answers what the agent asks — and it will ask:

- **Folder trust** on first launch: Enter.
- The chaos playbook's agent **stops to confirm the invitation** ("do you recognise this?"
  / "how to proceed?") — a two-part form. Answer both parts, then **Submit**. One Enter
  answers only the first part and the session sits forever looking busy.
- **Auto-mode classifier blocks `npm install -g`.** The person runs step 1 in a terminal
  and tells the agent to continue from step 2. Expected; the guide now says so.

Pilots that share one OAuth grant (identical `~/.claude/.credentials.json`) run
**sequentially** — parallel automated sessions on one grant rotate its refresh token and
strand the other.

## Operator checks (read-only, as admin)

- rooms per member and row counts in `mem.*`; who wrote (`system.parts` by table).
- **isolation:** as each member's own credential, `SELECT` on another member's rooms must
  be refused; `SHOW DATABASES` must not reveal more than `mem`.
- each pilot's `memhouse instance` names the right house, member, binding.
- each pilot's shipper log: the first pass must say `shipped N sessions`, never
  `Authentication failed` — the latter was the 0.18.1 install bug (shipper spawned with the
  pre-rotation password).

## Debrief and read — before the record

For every pilot: (1) **debrief its agent in its own tab** — what it ran, what it guessed,
what was wrong or contradictory (quoted), what looked failed but was not and the reverse,
whether it wanted to look outside the folder, where it believes its memory lives.
(2) **Read its session** — from the house (`<member>_messages` / `<member>_tool_calls`,
`folder LIKE '%inbox%'`) or the `.jsonl` on the VM — and compare with what it said. A
relayed summary or a pane snapshot is not a reading.

## Record

Write `drills/DRILL-<name>-<date>.md`: outcome, findings per repo (memhouse vs the
playbook), what was fixed, what was staging error. A finding in the playbook is not a
memhouse fix and vice versa; say which.
