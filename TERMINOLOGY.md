# Terminology — the canon

**This file is the source of truth for what things are called across the Ultimagent
constellation.** Every component repo carries a copy, plus a short section on how these terms
apply locally. If a word here disagrees with a word in a component, this file wins — open an issue
rather than diverging.

Last decided: **2026-07-28**.

---

## The two vocabularies

The realm is described twice, for two audiences:

- **The town vocabulary** — what a member, a guest, or a newcomer says. Geography and society.
  Plain English, no machinery.
- **The machine vocabulary** — what specs, catalogs, and code say. ClickHouse objects.

Both name the same system. A machine word appearing in a sentence aimed at a **member** is a
**leak**.

**The test is the audience, not the document.** Install runbooks, operator guides, and specs are
written for the person deploying a realm — often the mayor — and they legitimately say ClickHouse,
`GRANT`, and `MATERIALIZED currentUser()`. Rewriting those into town vocabulary would make them
false. The leak rule bites where a *member or guest* is the reader: a lobby notice, a greeting, a
front-door screen, a plugin description.

---

## Geography — where things are

| Town vocabulary | Machine vocabulary |
|---|---|
| **realm** | one deployment — the product category is *an Agent Realm* |
| **town** | a ClickHouse server instance |
| **house** | a database |
| **room** | a table |

A room address reads like a path: `acme.com/support/tickets`.

## Society — who does things

| Town vocabulary | Machine vocabulary |
|---|---|
| **mayor** | the human owner, holding a real superuser credential |
| **ego** | the `kernel` ClickHouse user — the realm's non-interactive executive |
| **agency** | a house **plus the residents working in it** (see below) |
| **resident** | something that acts **under its own identity** — a daemon, or a materialized view with a definer user |
| **member** | a registered user with grants |
| **guest** | the `guest` user — `SELECT` on the lobby only |

## The distinction that matters most

**A house is a place. An agency is a going concern.**

```
house                       = a database. Storage. It holds.
house + residents           = an agency. It acts.
```

Not every house is an agency. The **identity realm** is the canonical counter-example: one shared
table where insert = read, with **no resident** — the table *is* the logic. That is a house with
no agency.

This is why the English word fits. A travel agency, an employment agency, an ad agency: what makes
it an agency is *people acting on your behalf*, never the filing cabinet. It also makes the old
parenthetical literal — an agency is precisely the part of a realm that has **agency**.

**You install an agency.** What lands in the town is a **house** with **residents**.

Residents come in three kinds (`[[resident]].kind`):

| kind | what it is |
|---|---|
| `none` | nothing acts — the table *is* the logic (a house, not an agency) |
| `worker` | deterministic logic acting under its own identity — a daemon, or a materialized view with a definer user |
| `agent` | an autonomous LLM resident |

**A resident is defined by having an identity of its own.** That is the test, and it is what makes
the house/agency line decidable rather than a matter of taste. A daemon authenticates as some
user; a materialized view can carry a definer. A **plain view or a UDF has no identity** — it
executes as whoever queries it — so it is part of the *house*, not a resident, and a database
whose only moving parts are views is still a house.

## Things you ask for

| Town vocabulary | Machine vocabulary |
|---|---|
| **asking for something** | a row in `sys.calls`; the answer in `sys.call_results` |
| **joining** | registration → a minted ClickHouse user + grants |
| **what you may do** | `GRANT`s and row policies — *capability = exactly the grants* |
| **the lobby** | the `lobby` house — `readme`, `rules`, `directory` |
| **the front page** | the `_index` table (+ `_rules`) |
| **your keys** | named collections you can use but not read |
| **the schedule** | timers, ticked by a refreshable materialized view |

## Machine-only — never use these outward

`argMax` · append-only · snowflake cursor · Backend B · cursor seam · the catalog · syscall ·
`MATERIALIZED currentUser()` · `ROLE ADMIN` · `<agency>_root` · processor (Extractor / Tagger /
Distiller) · typed room · contract · conformance · settled watermark

*Note: **processors** are designed, not built. memory-house's live residents today are the
`agent-sync` shipper and its materialized views. The term describes the design, not running code.*

Terms with no counterpart are a feature. A member never needs the word `argMax`, and the kernel
has no concept of a "public square."

---

## The public register — delivery materials

READMEs' top halves, kick-starter prompts, plugin descriptions, the hosted signup, and any
member-facing screen use **exactly this register and nothing else**. The name budget is spent; a
synonym is a cost, not a convenience.

| Public word | Meaning |
|---|---|
| **Ultimagent** | the project |
| **realm** | your organization's place for agents, at your domain |
| **town** | the server behind a realm |
| **agency** | what you install on a realm (memory, files, keys, a help desk) |
| **join / deploy / hosted** | the three ways in |

*Supersedes `DELIVERY-2026-07-13-v2.md` §1, whose register predates this canon: it listed the
retired **agent-house** as the public word for a town, treated **town** as an internal word to be
hidden, and used **app** for the installable unit. **`agency` replaces `app`** (decided
2026-07-29) — `app` plus `agency` plus the retired `module` was three words for one thing, which is
exactly the sprawl that register exists to prevent.*

Still correct from that document, and worth restating: **no new platform name.** Not "agent OS" as
a brand, not "agent orchestration platform." The platform *is a realm*. Orchestration
mis-positions — orchestrators schedule work; a realm is a place where agents live.

## Retired words — do not reintroduce

| Retired | Use instead | Why |
|---|---|---|
| **hall** | **house** | one word for a database; `-house` components are literally houses |
| **module** | **agency** (or **house**, if it has no residents) | superseded 2026-07-28 |
| **app** | **agency** | superseded 2026-07-29; the register keeps one word, not two |
| **faculty**, **organ** | **agency** | candidate names, never adopted |
| **agent-house** | **town**, or "my realm" | it named a whole deployment, but a house is one unit *inside* a town |
| **Mayor as a ClickHouse user** | **ego** / the `kernel` user | the mayor is a human; provisioning is the ego's job |
| **memorecall** | **`/mem:recall`** | retired 2026-07-29 — the shipped skill is `/mem:recall` (`mem-recall` on agents without namespacing), installed in production. The canon follows what people actually type |

The `agent-` prefix does no work — in an Agent Realm everything is agent-something.

---

## Still open

Kept visible on purpose; a glossary that hides unresolved naming is how drift enters.

- **The business that operates a town.** `agency` now means a working house *inside* a town, so
  the town-scale operator (the Foundry / hosting customer) needs its own word.
- **"Agent Realm"** is the product category. Any older text defining it as "a realm whose residents
  are LLM agents" is stale — `[[resident]].kind` already carries that.
- **`substrate-conventions` #9** still describes the `ego` as a least-privilege provisioner with no
  content `SELECT`. `ultimagent-kernel` SPEC v9 instead makes `kernel` all-powerful and derives
  content-blindness from the **closed catalog** having no content-read verb. The convention needs
  amending to the interface argument.
- **`governor`** is scope-skipped in the kernel but has a live component card and two contracts
  naming it as a consumer.
- **`filehouse` vs `clickhouse-fs`** — does the former absorb the latter?
- **Manifest and contract keys** still say `hall`: `realm.toml`'s `[[hall]]` / `[[hall.table]]`,
  and `contracts/cursor-seam.md`'s `(realm, hall, room)`. These are structural, not editorial —
  renaming them is a schema change and needs its own decision.

---

## Using this file in a component repo

Each component keeps a copy of this canon, followed by a short **"In this repo"** section: which
of these terms the component provides, consumes, or renames locally, and any vocabulary specific
to it. Keep the canon verbatim so drift is visible in a diff; put all local detail below it.

---

# In this repo

**memhouse is an agency, not merely a house.** Under the canon's identity test this is not a
judgement call — it is decidable, and memhouse decides cleanly.

**The test: does something here act under its own identity?** Yes, and it is the **shipper**
(`mem-house/shipper/ship.js`, and its predecessor `agency/ingest.js`). The shipper authenticates to
ClickHouse as its own user — `MEMHOUSE_USER`, either the agency owner `memhouse_root` or a member's
own credential — and the house stamps what it writes with `user_id MATERIALIZED currentUser()`.
That stamp *is* the identity, recorded per row, un-spoofable, and load-bearing: it is what makes
own-only RLS work at all. A process whose identity is written into every row it produces is a
resident by any reading of the test.

So the two halves are:

| Half | What | Identity? |
|---|---|---|
| the **house** | the `memhouse` database — typed `sessions` / `messages` / `tool_calls` rooms, plus the `sessions_v` view | no |
| the **resident** | the shipper — runs the 17 editor adapters, parses on the client, INSERTs typed rows on its own schedule (`--loop`) | yes — its own CH user |

**The view is not a resident, and that matters.** `sessions_v` is a *plain* view, not a
materialized view with a definer — it executes as whoever queries it and has no identity of its
own. Under the sharpened canon it is part of the *house*. memhouse has no materialized views at
all, so its agency status rests **entirely** on the shipper. This is the sharpest possible version
of the claim: strip the shipper and what remains is a database plus a view — a house, inert, with
nothing that acts.

That resident is `kind = worker`, not `agent`: deterministic logic, no LLM in the loop, which is
exactly why it is not a prompt-injection surface.

The identity realm is the canon's counter-example — one shared table where insert *is* read,
nothing acting. memhouse is the opposite shape: the interesting work happens *outside* the INSERT,
in something that must exist, must authenticate, and must keep running.

**This repo coined the phrase "installs on the kernel as an agency"** — and as of the 2026-07-29
register decision that phrase is canon-correct in *both* of its senses. Publicly, **agency** is now
the word for the installable unit (**`app` is retired**; `app` + `agency` + the retired `module`
was three words for one thing). Structurally, memhouse earns the word by having a resident. The
phrase used to be loose — it sometimes meant only "an installed application", the retired sense —
and that looseness has been corrected in the docs below.

**On the leak rule.** The canon's audience qualifier settles a question this repo would otherwise
have raised: `mem-house/delivery/kernel-install.md`, `AGENT-INSTALL.md`, and `PROMPT.md` are
operator- and agent-facing — install runbooks and a system-prompt snippet whose whole job is to
teach an agent to query ClickHouse. They legitimately say `GRANT`, `currentUser()`, and `SETTINGS
final=1`; rewriting them into town vocabulary would make them false. The register applies to
`README.md`'s top half and to member-facing plugin/skill descriptions, not to these.

## Terms this repo provides

| Term | Here it is |
|---|---|
| **agency** | `memhouse` — the memory agency: the `memhouse` house plus its shipper resident. Also the public word for what you install here |
| **house** | the `memhouse` ClickHouse database (`MEMHOUSE_DB`, default `memhouse`) — including `sessions_v`, a plain view with no identity |
| **room** | `sessions`, `messages`, `tool_calls` |
| **resident** (`worker`) | the shipper — `mem-house/shipper/ship.js`; earlier `agency/ingest.js`. Acts as its own CH user; **the only resident here** |
| **member** | a person with their own credential; rows stamped `user_id MATERIALIZED currentUser()` |

## Terms this repo consumes from the kernel

| Term | How it arrives |
|---|---|
| **town** | the ClickHouse server instance the house is provisioned into |
| **realm** | the deployment that town belongs to |
| **ego** | the `kernel` ClickHouse user — runs `install-agency`, mints members, applies `rls.sql` |
| **mayor** | the **human** owner: approves the install; can apply `rls.sql` directly (interim path) |
| **asking for something** | `install-agency{name:'memhouse'}`, `register-member{handle}` — rows in `sys.calls` |
| **what you may do** | the owner grants on `memhouse.*`, plus the own-only row policies in `rls.sql` |

## Vocabulary specific to memhouse

Not in the canon, and not meant to be — these are memhouse's own words:

- **shipper** — the resident process; the thing that makes this an agency. `ship`/`shipping`/
  `re-ship` are its verbs.
- **parse-on-client** — the first bet: adapters run on the member's machine, typed rows go over the
  wire. Distinguishes memhouse from memory-house, which ships raw lines and parses in views. In
  canon terms the bet *moves work out of the house and into the resident*: memhouse's derived layer
  has no identity precisely because all the parsing already happened in something that does.
- **adapter** / **editor** — the 17 per-editor session readers inherited from agentlytics
  (`editors/`). "editor" here means Claude Code, Cursor, Zed, … — not a text-editing UI.
- **typed common schema** — physical typed columns across all 17 editors, versus derived-in-view.
- **owner** — `memhouse_root`, the account the ego hands back at install. In canon terms this is the
  agency's own privileged account, distinct from both the ego (kernel-wide) and the mayor (human).

## Where this repo disagrees with the canon

Recorded rather than silently reconciled.

1. **`agency` is also a directory and a filename.** `agency/`, `agency/agency.js`,
   `agency/house-schema.sql`, and the log prefix `[agency]` predate the sharpened definition. They
   name the *earlier agentlytics wrap*, kept as prior art, and are structural — renaming them is a
   code change, not an editorial one. Left alone deliberately.
2. **`agent-desk tier`** (`agency/ingest.js`, `agency/AGENCY.md`) is an ultimagent trust-tier name
   using the `agent-` prefix the canon calls dead weight. It is not on the retired list and it
   carries a real technical claim (no LLM, therefore no injection surface), so it stands until the
   tier itself is renamed upstream.
3. **`realm` used loosely as "a ClickHouse server".** Older text here (and the schema comments
   "the realm session store", "realm session schema") used *realm* where the canon now says *town*.
   Corrected in prose; **not** corrected in SQL comments or identifiers.
4. **Stale repo name in a runbook.** `mem-house/delivery/AGENT-INSTALL.md:12` still reads
   `cd <repo>   # the ultimagent-agentlytics checkout`; the repo is `memhouse`. Not a terminology
   question — a plain staleness bug — so it is left for a follow-up rather than fixed under a
   docs-only canon pass.
5. **memhouse competes with `memory-house` on the memory plane.** Two agencies, two houses, one
   schema-level convergence. If memhouse wins it becomes memory-house v4 — at which point the
   agency name and the component name diverge for a while. Noted so the constellation catalog does
   not treat the duplication as drift.

## Sweeps that came back clean

Recorded so a later pass does not redo them:

- **`hall`**, **`module`** as the installable unit, **`agent-house`** — no occurrences anywhere in
  this repo (docs, JS, SQL, config). Those retirements are no-ops here.
- **`app`** as the installable-unit noun (retired 2026-07-29) — no occurrences. Every `app` in the
  tree is an Express application object (`index.js`, `relay-server.js`) or a macOS `.app` bundle
  path in the editor-discovery table; `AGENTLYTICS-README.md`'s "requires their app to be running"
  means the Devin/Antigravity desktop application. None is the installable unit; none changed.
- **`memorecall`** (retired 2026-07-29 → `/mem:recall`) — no occurrences. memhouse ships its own
  skills under the `memhouse-*` / `/memhouse:*` names (`memhouse-search`, `memhouse-sessions`,
  `memhouse-sql`), which are unaffected by that retirement.
