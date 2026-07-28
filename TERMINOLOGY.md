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

Both name the same system. A machine word appearing in a sentence aimed at a member is a **leak**.

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
| **resident** | a scoped ClickHouse user doing that work |
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
| `none` | no resident — the table *is* the logic (a house, not an agency) |
| `worker` | deterministic compiled logic — an MV, a view, a UDF, a daemon |
| `agent` | an autonomous LLM resident |

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

Terms with no counterpart are a feature. A member never needs the word `argMax`, and the kernel
has no concept of a "public square."

---

## Retired words — do not reintroduce

| Retired | Use instead | Why |
|---|---|---|
| **hall** | **house** | one word for a database; `-house` components are literally houses |
| **module** | **agency** (or **house**, if it has no residents) | superseded 2026-07-28 |
| **faculty**, **organ** | **agency** | candidate names, never adopted |
| **agent-house** | **town**, or "my realm" | it named a whole deployment, but a house is one unit *inside* a town |
| **Mayor as a ClickHouse user** | **ego** / the `kernel` user | the mayor is a human; provisioning is the ego's job |

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

**memhouse is an agency, not merely a house.**

The canon's test is residency: a house is a database that holds; an agency is a house *plus the
residents working in it*. memhouse ships both halves. The house is the `memhouse` database — typed
`sessions` / `messages` / `tool_calls` rooms. The resident is the **shipper** (`mem-house/shipper/ship.js`,
and its predecessor `agency/ingest.js`): a long-lived process that runs the 17 editor adapters,
parses on the client, and INSERTs typed rows on its own schedule (`--loop`). Nothing about the
house causes that to happen — remove the shipper and the database is inert storage, a house with
no agency. That resident is `kind = worker`, not `agent`: it is deterministic compiled logic with
no LLM in the loop, which is exactly why it is not a prompt-injection surface.

The identity realm is the canon's counter-example of a house with no agency — one shared table
where insert *is* read. memhouse is the opposite shape: the interesting work happens *outside* the
INSERT, in a resident that must exist and must keep running.

This repo is also the origin of the phrase **"installs on the kernel as an agency."** Under the
sharpened canon that phrase is still correct here — but only because of the shipper. It was
sometimes used loosely to mean "an installed app"; that sense is now wrong and has been corrected
in the docs below.

## Terms this repo provides

| Term | Here it is |
|---|---|
| **agency** | `memhouse` — the memory agency: the `memhouse` house plus its shipper resident |
| **house** | the `memhouse` ClickHouse database (`MEMHOUSE_DB`, default `memhouse`) |
| **room** | `sessions`, `messages`, `tool_calls`, plus the `sessions_v` view |
| **resident** (`worker`) | the shipper — `mem-house/shipper/ship.js`; earlier `agency/ingest.js` |
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

- **shipper** — the resident process. `ship`/`shipping`/`re-ship` are its verbs.
- **parse-on-client** — the first bet: adapters run on the member's machine, typed rows go over the
  wire. Distinguishes memhouse from memory-house, which ships raw lines and parses in views.
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
4. **memhouse competes with `memory-house` on the memory plane.** Two agencies, two houses, one
   schema-level convergence. If memhouse wins it becomes memory-house v4 — at which point the
   agency name and the component name diverge for a while. Noted so the constellation catalog does
   not treat the duplication as drift.
