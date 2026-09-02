# Drillbook — the shared house

**Written 2026-09-02, before staffing. Do not edit after the drill begins.**

Version under drill: `memhouse 0.17.0` from `claude/table-prefix`, installed on `testbed`
from a packed tarball. `memhouse version` on the machine is the record.

## Why this drill

Everything else about this layout has been checked by people who read the code. Four
matrices (64 assertions) prove the mechanism against a real ClickHouse, and a two-member
end-to-end on `testbed` proves 22,340 rows land in the right rooms under concurrent load.

None of that can tell us whether any of it makes sense to somebody who has not read this
repository — and this layout changes the two things a newcomer meets first: what their
tables are called, and what "your house" means when the database is shared.

## Roles staffed

| role | seat | holds |
|---|---|---|
| **operator** | a tab, `claude` | administers a ClickHouse where a database per person is not available. Wants two colleagues shipping their memory into it. |
| **arriver** | a tab, a *different* agent kind | handed one file and one sentence. Has never heard of memhouse. |
| **grantee** | a tab | a colleague of the arriver, already a member, who is offered a look at their memory. |
| **principal** | the pilot | answers as a real principal would, and explains nothing. |

Two agent kinds minimum. A door only `claude` can open is a door with a problem.

## The situations

Run them in order; each leaves the house in the state the next one starts from.

1. **The operator has a ClickHouse and two colleagues.** They cannot create a database per
   person on it. By the end, both colleagues are shipping, and the operator can say — from
   the house itself — who is in it and what each can reach.

2. **The arriver is handed `dana.env` and told: "this gets your Claude Code history into
   the team's memory."** Nothing else. By the end they are either shipping or they have
   said what stopped them.

3. **The arriver wants to know what memhouse is actually storing about them, and where.**

4. **The grantee asks the arriver for a look at one project's worth of their memory.** By
   the end the arriver can state what they opened and to whom, and close it again.

5. **A third colleague should join.** The operator adds them.

## What the agents are not told

Everything except the file and the sentence in their situation. In particular: not that a
prefix exists, not that the rooms carry their name, not that `memhouse rooms` exists, and
not which command does any of it. If an agent needs a flag, it must find it.

The repository is unreachable to all of them — `testbed` has no checkout, which is the
condition, not a promise. The installed package's own `README.md` and `/mem:*` skills are
in scope: a real member has those, and if they mislead, that is a finding of the first
order.

## Standing questions for every seat, asked at the end

- What did you have to guess?
- What did memhouse tell you that turned out to be wrong?
- Was there a moment you thought something had failed when it had not?
- What did you expect to exist and could not find?

## Conditions

- Fresh context per agent. Anything an agent knows that a real newcomer would not, it must
  not know — including anything from an earlier attempt at this drill.
- House `drill` on the lab at `10.10.10.30:18300`. Provisioned and destroyed by the drill;
  it is nobody's real memory.
- The principal does not help. If the member seat cannot see something, that is a finding,
  not an inconvenience to route around with the admin credential.

The record goes in `drills/DRILL-shared-house-2026-09-02.md`, written after, not now.
