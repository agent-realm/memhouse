# Drill — an invitee arrives, one-layout build

**2026-09-08.** Version under drill: `memhouse 0.18.0-nightly.20260908T0606` (main), installed
from a packed tarball, no checkout on the machine. House: a `lab` ClickHouse 26.7 at
`10.10.10.30:18300`. Venue: `testbed`. Seat: **arriver** — a fresh agent (sonnet), no repo
access, given only a directory holding `invite-drilla.env` and `MEMHOUSE-INVITATION.md` and
one sentence. It was told to get its memory shipping by following the folder.

## Outcome: passed the gate

On a clean machine the arriver installed, joined, and shipped **147 sessions / 22,340
messages** into `mem.drilla_*`, and verified isolation from its own seat: `whoami --json`
showed a single `member` grant scoped to `mem.drilla_*`, no superuser. It confirmed
shipping four independent ways (doctor, stats, the shipper log, and `search` pulling its own
content back). The core loop works end to end for someone who has never seen the repo.

## Findings

1. **"old house" conflated house with credential.** The machine had a stale config for the
   SAME server and database under a different, already-broken user. Installing over it said
   "stopped the shipper — it was pointed at the old house" and "keeps writing to the old
   house" — which reads as data loss when nothing moved. FIXED: says "old credential" when
   the URL and database are unchanged.

2. **The missing-tarball error is misleading — but this was a staging artifact.** Step 1 of
   the guide (pre-release path) says `npm install -g ./memhouse-*.tgz`, and npm, given no
   matching file, prints `tarball data … seems to be corrupted` twice before the real
   `ENOENT`. In the drill there was no tarball in the folder because the build was
   pre-installed system-wide; a real invitee is sent the tarball, and a house on a channel
   shows `npm install -g memhouse@<channel>` with no glob at all. Left as-is; noted so the
   staging is done right next time (put the tarball in the inbox, do not pre-install).

3. **doctor vs status race, cosmetic.** For a few seconds after install, `doctor` said
   "nothing shipped from here yet" while `status` already showed a ship 0m ago. Self-resolved
   on the next pass. Not fixed; it is a snapshot of two reads across one shipper pass.

4. **"done looked identical to stuck."** The first pass finished in 11.6s, before the
   arriver's first `status` poll, so counts never moved for two minutes and read as a stalled
   shipper. A "last pass shipped N at HH:MM; next in Ns" line on `status` would remove the
   ambiguity. Recorded, not built.

## Staging notes for next time

Testbed carried leftovers from earlier drills — a broken `dana` config, stray
`~/Downloads/memhouse-*.env`, `.memhouse-alice`/`.mh-alice` dirs. `bin/rollback-synced.sh`
should run before a drill so the machine is genuinely fresh; it was not, and the arriver
spent effort reasoning about junk that was not part of the test.
