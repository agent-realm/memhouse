# Drill — team arrival: two invitees join one house through chaos-santiment

**2026-09-10.** Build under drill: **memhouse 0.18.1 as published on the `team` channel**
(`npm install -g memhouse@team`). House: `lab` ClickHouse **25.8** (santiment's version).
Operator: TART, from macminim, 0.18 binary. Pilots: **mira** on `testbed` (106), **deniz**
on `testbed-rpolat` (108), each with `~/inbox/` holding the two files and the
`chaos-santiment` v0.1.11 playbook installed; each launched
`chaos-santiment "Read MEMHOUSE-INVITATION.md … follow it"`. mira ran headless
(`-p --dangerously-skip-permissions`, driven by a subagent); deniz ran the real TUI in a
herdr tab with a person (TART) answering its prompts. Cockpit: herdr workspace
`memhouse-drill`, one tab per pilot plus an operator tab. Staging per
`DRILLBOOK-team-arrival-2026-09-10.md`.

## Outcome

**Both joined; neither shipped.** Both installs printed `✓ installed`, `✓ password
rotated`, `✓ shipper started`; both shippers then failed **every pass** with
`Authentication failed` while every CLI command the pilots ran succeeded. Isolation held
from both seats (own five rooms only, the other's rooms refused and invisible, one
database). Two restarts by the operator later, mira holds 170 sessions / 22,448 messages
and deniz 23 / 104.

## Findings — memhouse (all fixed on `claude/rotate-before-spawn`)

1. **The shipper spawned by `install --env` held the pre-rotation password.** `--env`
   hoists the invite's values into `process.env`; `resolveConfig` prefers `process.env`
   over the env file; the rotation rewrote the file only. Reproduced on both machines,
   independently, on the published build. FIXED: install adopts what the file says before
   spawning; the shipper adopts a newer file credential on auth failure and retries in a
   second. The invite matrix asserts it; the assertion fails on 0.18.1.
2. **`status` and `doctor` called a failing shipper healthy.** Judged by pid only. mira's
   driller, deniz's agent, and deniz's `doctor` all read an empty house as "first pass
   still catching up" — the tool's own "a large first ship can take a few minutes" line
   invited it. Deniz's agent found the truth only by opening the log file itself. FIXED:
   both read the log's last pass; a failing one is `✗` with the remedy.
3. **The guide had no answer for an agent that cannot install.** Under chaos-santiment's
   auto permission mode, the classifier blocked `npm install -g memhouse@team`. FIXED in
   the guide: the person runs step 1, tells the agent to continue from step 2.
4. Cosmetic, recorded, not fixed: `doctor` exits 1 over the optional dashboard while
   everything else is green (both pilots noted it); "done" and "stuck" look the same on
   `status` between passes.

## Findings — chaos / chaos-santiment (fixed on `claude/memhouse-invite-0.18` in both)

5. **The `chaos:memhouse` skill said the invite carries an admin bootstrap credential
   and to prefer a `--member` path.** False since 0.11; `--member` is the inviter's flag.
   Deniz's agent, reading skill and guide side by side, judged the *guide* the suspicious
   one and stopped to ask. The skill now says what the invite holds and that the guide
   beside the invite is authoritative for its version.
6. **`chaos-setup.sh` installs bare `npm i -g memhouse`** — `latest`, 0.17.0, the wrong
   layout for a team house. Deniz's agent ran exactly that (it "avoided the unfamiliar
   tag"); only an `EACCES` on a rename stopped a downgrade. Now installs from the invite's
   `MEMHOUSE_CHANNEL`.
7. `rm -P` in the skill and the script is BSD-only; fails on Linux (`invalid option`).
   Both pilots' agents hit it and fell back to `shred -u`. Portable now.
8. The script's post-install warning told the pilot to shred a file the preceding line
   had just reported removed. Reworded to name the file that actually remains.
9. Recorded, not fixed: the script calls memhouse "optional" while the preflight banner
   flags its absence red; the auto-mode classifier's rules are invisible to the agent.

## What the drillers said that a summary would have lost

- deniz's agent, before installing: *"the file itself carves out one required checkpoint
  — 'Ask before `memhouse install --env`…' Your instruction to not stop and ask would
  waive exactly that checkpoint."* It refused a blanket authorization on that basis. That
  is the playbook working.
- deniz's agent, on green output: *"All technically true — the process runs, the TCP
  connection works — and all of it sat on top of a credential that had already failed
  authentication on its first pass. Nothing about the green output told me that."*
- deniz's agent, wanting to look outside: *"the memhouse source itself… wherever `install
  --env` persists the rotated password — to tell whether this is a memhouse bug (writes
  the pre-rotation value)."* It named the bug from the symptoms.
- mira's agent never tried the guide's easy path (bare `memhouse` beside the file); the
  skill sent it to `chaos-setup.sh` from turn one. Both agents did.

## Staging errors, mine

- A pre-installed 0.17.0 `/mem` rode along on both VMs (an rsync exclude that silently
  missed); removed before launch.
- A second `pane run` typed into a live shell and started a nested ssh in deniz's tab.
- Deniz's confirmation was a two-part form; one Enter answered half and the session sat
  idle 28 minutes looking busy.
- The pilots share one OAuth grant; they ran sequentially for that reason.

## Not yet done

Round two with **four** pilots — two `chaos`, two `chaos-santiment` — on the fixed
playbooks and a published 0.18.2, each debriefed in its tab and each session read from
the house before the record is written.
