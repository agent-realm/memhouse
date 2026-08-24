# Drills

A **drill** is memhouse being used by agents in the roles it was built for — arriving,
installing, recalling, sharing, administering — **none of whom have read this repository.**

A test asserts. A matrix checks. **A drill is the thing being used.**

The instrument is borrowed from [`kernel`](https://github.com/agent-realm/kernel)
(`drills/DRILLS.md` there); what follows is the same idea with memhouse's roles and
surfaces. Where the two disagree, kernel's document is the original.

---

## Why this is a third instrument

`npm test` asks *is the logic right*. `misc/invite-matrix.sh` asks *does the mechanism
work against a real ClickHouse*. Both know the answer before they start, because whoever
wrote them read the code. That is their strength, and it is exactly why neither noticed:

- that `memhouse invite` announced *"it can manage users on this house"* to a credential
  that could not, then died three steps later with a raw `ACCESS_DENIED`
- that `/mem:admin` told people to put an admin password in `~/.memhouse/admin.env`, a
  file memhouse has never created
- that `/mem:invite` branched on a refusal string the CLI had stopped printing
- that the hidden-password prompt hung forever on a **pasted** secret, which is how a
  password out of a manager actually arrives

Every one of those was found by *using* the product, and four of them shipped first.

> **A test checks memhouse against its code. A drill checks memhouse against the people
> using it.**

## The roles a drill staffs

Not every drill staffs all of them. Which ones you staff is the drill's whole design.

| role | what it exercises |
|---|---|
| **arriver** | the front door: a person handed an invite file who has never heard of memhouse |
| **member** | daily use — recall, analytics, "is my memory working" |
| **sharer** | opening a house to someone, in whole or in part, and being able to say what was opened |
| **grantee** | the other side of a share: what they can reach, and whether they can tell what they cannot |
| **admin** | provisioning, auditing, and destroying, with the credential that can |
| **observer** | whether what happened is legible afterwards, from the house itself |

## A drill plan

**Write one before staffing anybody.** A drill without a plan becomes "watch someone
install it", which is one situation out of many and the only one anybody remembers to try.

A plan names three things:

1. **The roles staffed**, and which agent kind holds each.
2. **The situation** — what should be true by the end. *A stranger installs from an invite
   file and finds something they worked on.* *A member shares one project and the grantee
   tries to read another.* *Someone who is not an administrator tries to invite a
   colleague.*
3. **What the agents are not told** — usually everything except what their principal would
   really hand them: a file, a sentence, a URL.

**A plan must not contain expected results.** The moment it says *and invite should refuse
with the member message*, whoever wrote it read the code, and the drill is a test that
knows the answer. A plan describes a **situation to create**, never an outcome to confirm.

Write the plan into `drills/DRILLBOOK-<slug>-<YYYY-MM-DD>.md` before the drill begins, and
do not edit it afterwards. What happened goes in the drill record.

## Conditions

**A real installation, not a checkout.** `node bin/memhouse.js` from the repository is not
memhouse; it is the source with the design sitting next to it. Install the built package
on a machine that has no checkout — `memhouse nightly` produces one, and `testbed` is the
standing venue.

**Agents that cannot read this repository.** The load-bearing condition and the easiest to
break. An agent that can open `bin/memhouse.js` resolves ambiguity by reading the source
instead of reporting it, and the report was the point.

> The installed package's own `README.md` and the `/mem:*` skills **are** in scope — a
> real user has them, and if they mislead, that is a finding of the first order. What must
> be unreachable is everything a user would not have: the repo, `DESIGN.md`, `CHANGELOG.md`,
> the tests, and this document.

**Every agent starts with an empty context, every time.** Restart or `/clear` before the
drill begins — never reuse one from a previous drill or an earlier attempt at this one. An
agent that already knows the flag is `--print-sql` will use it whether or not the product
still says so, and the drill then measures its memory instead of memhouse. **Anything the
agent knows that a real newcomer would not, it must not know.**

**One agent per tab, named for its role.** Two kinds beat one — a door only `claude` can
open is a door with a problem.

**A house that is not yours.** Drills provision and destroy. Point them at a sandbox
house, never at the house you actually keep your work in.

## Running one

1. Write the plan. Note the version installed and how (`memhouse version` verbatim).
2. Staff the roles, one agent per tab, plus whatever the drill needs to watch.
3. Hand each agent only what its role gets. Then **do not help.**
4. Answer only as that agent's principal would: *yes, go ahead*, *call yourself anything*.
   Never explain memhouse.
5. Play the seats you kept honestly. If the member seat cannot see something, that is a
   finding, not an inconvenience to route around with the admin credential.
6. Ask every agent, at the end, what memhouse failed to tell it.

## What counts as a finding

Anything anyone had to guess, work around, or ask about — in any seat.

- something memhouse told them to run and they could not
- something they read that turned out to be untrue
- two situations they could not tell apart — *refused* and *broken* especially
- something they did that the design did not expect, and memhouse allowed
- somewhere they stopped, and memhouse offered no way forward
- a secret that ended up somewhere it should not be

**A clean run is a weaker result than a messy one.** If everyone sails through, the drill
mostly confirms that the last drill's findings were fixed.

## What a drill must not do

**Never fix memhouse mid-drill.** The participants are measuring it as it stands; a
correction halfway means the record describes a build that never existed. Note it and
carry on.

**Never argue with a finding.** Someone who misread something misread it because the text
allowed misreading. *"It should have known"* is not a defence — **the text is the
interface, and the interface failed.**

**Never let a drill write to a real house.** Provisioning, sharing and dropping are all in
scope, which is exactly why the target must be disposable.

## Recording one

```
drills/DRILL-<slug>-<YYYY-MM-DD>.md
```

Carrying: the plan as written beforehand, linked and unedited; the version installed and
where; who held which role, which agent kind, and where they ran; what happened in order;
where anyone hesitated; what they reported when asked; and what changed as a result. Name
the agent kinds — a defect both `codex` and `claude` hit is stronger evidence than one
either hit alone.

## When to run one

After the matrix passes, because green mechanisms are exactly when the remaining defects
are the ones only use reveals.

Before a release that changes a surface a person touches — the invite flow, the skills,
the first-run experience.

And whenever the front door changes, since that is the surface a drill exercises hardest.
