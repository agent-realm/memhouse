# Terminology — the canon

**This file is the source of truth for what things are called across the Ultimagent
constellation.** Every component repo carries a copy, plus a short section on how these terms
apply locally. If a word here disagrees with a word in a component, this file wins — open an issue
rather than diverging.

Last decided: **2026-07-29**.

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
| **resident** | something that fires on a trigger and **writes** — a daemon, a scheduled view, an insert-triggered view. See the test below |
| **routine** | something that is **called and returns**, changing nothing — a view, a UDF, a parameterized view. House machinery, not a resident |
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

## The resident test

**Residents write. Routines read.**

A **resident** fires on a trigger and does work that outlives the query — it changes or maintains
state. A **routine** is computed *during* your call, *for* your call, and changes nothing.

| | trigger | writes? | verdict |
|---|---|---|---|
| a daemon | a loop | yes | **resident** |
| a refreshable / scheduled MV | a schedule | yes | **resident** |
| an insert-triggered MV | someone else's insert | yes | **resident** |
| a plain view | your query | no | routine |
| a **`DEFINER` view** | your query | no | routine |
| a UDF, or a parameterized view wrapping one | your call | no | routine |
| a table | nothing | — | neither; it *is* the house |
| a `MATERIALIZED` **column** | your own insert | it is your insert | neither; part of the table |

The test is mechanical: **does it produce a write?** No judgement about autonomy required.

**A `MATERIALIZED` column is not a resident.** It computes during *your* insert and is stored by
*your* statement — it is part of the table's definition, like a `DEFAULT`, not a separate
mechanism firing on a trigger. This matters: the identity realm's `main.log` uses materialized
columns and is still a house with no residents.

**Why a `DEFINER` view is a routine.** It has an effective identity — it runs as its definer, not
as the querier — but it writes nothing and only runs when you ask. That is exactly why granting a
`guest` `SELECT` on one is safe, and it is why "has a definer" is not the test. Nor is "is it
materialized": a materialized view can lack a definer and run as whoever inserted, and a plain
view can carry one. **The view/materialized axis is irrelevant. Writing is the axis.**

**The one exception.** An **executable UDF** shells out and can act outside the database. It is
the single routine that can smuggle residency, which is why it is `[BW]` and gated behind
[iron-proxy](components/iron-proxy.md).

### Residency and identity are different axes

Residency asks *does it act*. Identity asks *under whose name* — which determines attribution and
blast radius. Identity is a **security property of a resident**, not part of the definition of
one. An insert-triggered MV with no definer is a resident that happens to run as the inserter;
that is a fact about its privileges, not about whether it is a resident.

### The kinds

Two orthogonal keys, because nature and trigger vary independently:

```toml
[[resident]]
kind = "worker" | "agent"                 # nature — deterministic code, or an LLM
on   = "insert" | "schedule" | "loop"     # trigger — what fires it
```

A house with **no `[[resident]]` at all** is a house, not an agency — the identity realm.

*(Say **resident**, and let the keys carry the variation. "Resident program", "resident code",
"resident trigger" multiply vocabulary for one concept; a resident with `on = "insert"` says it
precisely.)*

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
`MATERIALIZED currentUser()` · `ROLE ADMIN` · `<agency>_root` · **routine** · processor
(Extractor / Tagger / Distiller) · typed room · contract · conformance · settled watermark

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

**`agency` carries two senses, and only one of them has a test.** Publicly it is *the thing you
install* — the word you say to a member. Structurally it is *a house with residents*. Nearly every
installable unit is both, but not all: **keyhouse** installs as an agency and is structurally a
house, because nothing in it acts unasked. Say "install the keys agency" to a member; call it a
house in a spec. If that ever grates, the structural sense is the one with a test, and the public
sense is the one that should give way.

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
- **`hall` in agent-rooms is deliberately left.** Decided 2026-07-29: the manifest and contract
  keys were renamed everywhere else — `realm.toml` now uses `[[house]]` / `[[house.room]]` and
  `entry_house`, and the cursor seam keys on `(realm, house, room)` — but **agent-rooms keeps
  `hall_id`, `create_hall`, `DEFAULT_HALL` and its `AR_*` env surface** (69 occurrences across 17
  files, including a schema column). That rename is a migration, not an edit, and is not scheduled.
  Read `hall` in agent-rooms as `house`.

---

## Using this file in a component repo

Each component keeps a copy of this canon, followed by a short **"In this repo"** section: which
of these terms the component provides, consumes, or renames locally, and any vocabulary specific
to it. Keep the canon verbatim so drift is visible in a diff; put all local detail below it.

---

# In this repo

**memhouse is an agency, not merely a house.** Under the canon's test — **residents write,
routines read** — this is not a judgement call. It is mechanical, and memhouse answers it with an
unusually clean margin.

**The test: does anything here produce a write?** Exactly one thing does — the **shipper**
(`mem-house/shipper/ship.js`, and its predecessor `agency/ingest.js`). It fires on a trigger no
query supplies (a loop, `--loop 300`), runs the 17 editor adapters, and INSERTs typed rows. Its
work outlives the call that started it: nobody is waiting on that INSERT, and the rows are still
there tomorrow. That is a resident.

```toml
[[resident]]
kind = "worker"    # deterministic code, no LLM
on   = "loop"      # a daemon, not an insert trigger or a schedule
```

Everything else in the tree reads:

| Object | Trigger | Writes? | Verdict |
|---|---|---|---|
| the shipper | its own loop | **yes** | **resident** |
| the session rollup (`sessions_v`, SQL text — not an object) | your query | no | routine |
| `messages_v` / `sessions_v` in `agency/house-schema.sql` (prior art) | your query | no | routine |
| `sessions_<m>`, `messages_<m>`, `tool_calls_<m>` | nothing | — | neither; they *are* the house |
| `all_sessions` / `all_messages` / `all_tool_calls` (`Merge`) | your query | no | neither; a read path over those rooms |
| `user_id MATERIALIZED currentUser()` | your own insert | it *is* your insert | neither; part of the table |

**The margin is the point: memhouse has no materialized views at all** — and since 0.4.0,
`mem-house/` has no stored views of any kind. The session rollup is a **saved query**, substituted
with the caller's own room names and run under their credential (`per-member/rooms.js`), so the
derived layer owns no object at all; the only `CREATE OR REPLACE VIEW` left in the repo is in
`agency/house-schema.sql`, kept as prior art. So there is no borderline case to argue about, no
scheduled refresh, no insert trigger. The shipper is not merely *a* resident; it is provably the
*only* candidate in the repo. Strip it and every remaining moving part is a routine over rows
nobody is writing any more.

**A correction against my own earlier reading.** The `user_id MATERIALIZED currentUser()` stamp is
a materialized **column**, which the canon now explicitly rules is *neither* resident nor routine —
it computes during your insert, stored by your statement, part of the table's definition like a
`DEFAULT`. It is not what isolates members — an absent grant on someone else's room does that — but
it records who wrote each row, which is what keeps provenance across a share and keeps the `Merge`
rooms meaningful. It is a **security property**, on the identity axis, not evidence of residency.
Residency asks *does it act*; identity asks *under whose name*. memhouse is an agency because of
the loop, not because of the stamp.

The identity realm is the canon's counter-example — one shared table where insert *is* read,
nothing firing on any trigger, and (tellingly) materialized columns that do not change that.
memhouse is the opposite shape: the work happens *outside* anyone's query, in something that must
exist and must keep running.

**This repo coined the phrase "installs on the kernel as an agency"** — and it is now correct in
*both* of the canon's senses at once. Publicly, **agency** is the word for the installable unit
(**`app` is retired**). Structurally, memhouse earns it by having a resident that writes. The two
senses can come apart — the canon's own example is **keyhouse**, which installs as an agency but is
structurally a house because nothing in it acts unasked. memhouse is not that case; it satisfies
the sense that has a test. The phrase used to be loose, meaning only "an installed application";
that looseness is corrected in the docs below.

**On the leak rule, and on `routine`.** The canon's audience qualifier settles a question this repo
would otherwise have raised: `mem-house/delivery/kernel-install.md`, `AGENT-INSTALL.md`, and
`PROMPT.md` are operator- and agent-facing — runbooks and a system-prompt snippet whose whole job
is to teach an agent to query ClickHouse. They legitimately say `GRANT`, `currentUser()`, and
`SETTINGS final=1`; rewriting them into town vocabulary would make them false. Separately,
**`routine` is on the machine-only list**, so it appears in this file and in the design/spec docs
but deliberately **not** in `README.md`'s top half, which holds to the public register.

## Terms this repo provides

| Term | Here it is |
|---|---|
| **agency** | `memhouse` — the memory agency: the `mem` house plus its shipper resident. Also the public word for what you install here |
| **house** | the `mem` ClickHouse database (`MEMHOUSE_DB`, default `mem`; `memhouse` was the pre-0.4 default) |
| **room** | three plain shared tables per house — `sessions`, `messages`, `tool_calls`. Everyone in the house writes into the same ones with their own credential; `user_id MATERIALIZED currentUser()` says who. The per-member `sessions_<m>` layout and its `Merge` rooms were removed in 0.8.0: the database is the boundary, not the table name. `house_meta` / `house_events` are **not** rooms — they are the house's record of itself |
| **resident** | the shipper — `memhouse/shipper/ship.js`; earlier `agency/ingest.js`. `kind = "worker"`, `on = "loop"`. **The only resident here**, and insert-only since 0.10.0 |
| **routine** | the session rollup and the current-parse room filter — SQL text, not objects (`house/house.js`: `sessionsRollup`, `currentParse`), run under the caller over the house's rooms. Called, return, write nothing |
| **member** | a person with their own credential on the house, sharing its three rooms with every other member; rows stamped `user_id MATERIALIZED currentUser()` (a materialized column — identity, not residency) |

## Terms this repo consumes from the kernel

| Term | How it arrives |
|---|---|
| **town** | the ClickHouse server instance the house is provisioned into |
| **realm** | the deployment that town belongs to |
| **ego** | the `kernel` ClickHouse user — runs `install-agency`, mints members and their rooms |
| **mayor** | the **human** owner: approves the install; can mint rooms directly (interim path) |
| **asking for something** | `install-agency{name:'memhouse'}`, `register-member{handle}` — rows in `sys.calls` |
| **what you may do** | the grants the owner issued on your own rooms; no policy, and nothing granted on anyone else's |

## Vocabulary specific to memhouse

Not in the canon, and not meant to be — these are memhouse's own words:

- **shipper** — the resident; the thing that makes this an agency. `ship`/`shipping`/`re-ship` are
  its verbs.
- **parse-on-client** — the first bet: adapters run on the member's machine, typed rows go over the
  wire. Distinguishes memhouse from memory-house, which ships raw lines and parses in views. On the
  canon's write axis the bet reads exactly: **it moves work from routine to resident.** memory-house
  parses when you query — work done during your call, for your call. memhouse parses before anyone
  asks and writes the result down. That is why memhouse's derived layer can afford to write nothing:
  it is routines over rows the shipper already wrote.
- **epoch** — which parse of a session a transcript row belongs to. The shipper bumps it when a
  re-parse is shorter than the stored one or diverges from it at an overlapping `seq`, so the
  superseded parse is kept rather than overwritten. Reads take the newest epoch per session.
- **accumulator, not a mirror** — the house keeps what the source no longer has. Absence of a
  session on disk is never a signal, and neither `sync` nor `prune` may be built.
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
4. **Stale repo name in a runbook — RESOLVED 2026-07-30.** `AGENT-INSTALL.md` read
   `cd <repo>   # the ultimagent-agentlytics checkout`; it now reads `# the memhouse checkout`.
   The follow-up this item asked for has happened; kept in the list (rather than renumbered) so the
   history stays readable.
5. **memhouse competes with `memory-house` on the memory plane.** Two agencies, two houses, one
   schema-level convergence. If memhouse wins it becomes memory-house v4 — at which point the
   agency name and the component name diverge for a while. Noted so the constellation catalog does
   not treat the duplication as drift.
6. **~~`mem-house` (hyphenated) survives structurally~~ — REVERSED 2026-08-10. There is one
   name: `memhouse`.** The 2026-07-30 ruling split the name: `memhouse` on every surface a
   member, agent or npm browser reads, `mem-house` kept for the directory, the shipper's
   `[mem-house]` log prefix, code headers, SQL comments, the runbooks, and an npm keyword —
   on the grounds that those are structural, and renaming them is a code change rather than
   an editorial one.

   That reasoning was sound and the outcome still cost more than it saved. The split meant a
   reader met both spellings and had to know which surface they were on to tell whether it
   was drift; the pilot asked exactly that question on 2026-08-10 ("we retired memory-house
   and mem-house was old name"), which is the split working as designed and still being
   indistinguishable from rot. A name a reader has to be briefed about is not carrying its
   weight.

   So the code change was made: `mem-house/` is now `memhouse/`, the log prefix is
   `[memhouse]`, the npm keyword is dropped, and every header, comment, runbook and doc
   follows. `memory-house` is untouched and stays — it is a different product, the one this
   competes with and migrated from, and its name appears here as heritage and comparison,
   not as drift.


## Sweeps that came back clean

Recorded so a later pass does not redo them:

- **`hall`**, **`module`** as the installable unit, **`agent-house`** — no occurrences anywhere in
  this repo (docs, JS, SQL, config). Those retirements are no-ops here.
- **`app`** as the installable-unit noun (retired 2026-07-29) — no occurrences. Every `app` in the
  tree is an Express application object (`index.js`, `relay-server.js`) or a macOS `.app` bundle
  path in the editor-discovery table; `AGENTLYTICS-README.md`'s "requires their app to be running"
  means the Devin/Antigravity desktop application. None is the installable unit; none changed.
- **`memorecall`** (retired 2026-07-29 → `/mem:recall`) — no occurrences. memhouse ships its
  own skills under the `/mem:*` namespace (`/mem:recall`, `/mem:sql`, `/mem:house`,
  `/mem:sql`; the plugin was named `memhouse` until 0.10.0 and renamed `mem` by the
  pilot's decision — memory-house, the previous holder of `/mem:*`, is retired and the
  short name belongs to the living product). They earn the namespace by being installed
  as a PLUGIN — a directory carrying `.claude-plugin/plugin.json`. Copied in as loose
  skill directories they would register as unrelated top-level names, which is what
  happened until 0.4.5.
- **Manifest keys** — this repo has **no `realm.toml`**, so the `[[hall]]` → `[[house]]` /
  `[[house.room]]` / `entry_house` rename does not reach it. (The one `.toml` in the tree is an
  agent-gauntlet scenario config, `sandbox/vm-e2e/configs/`, which is not a manifest.) The
  `[[resident]]` block above is how memhouse *would* declare itself when a manifest lands.
- **Materialized views** — none, anywhere. Stronger since 0.4.0: `mem-house/` has no stored views
  at all, because the session rollup became a saved query. The only `CREATE OR REPLACE VIEW` left
  is in `agency/house-schema.sql`, the prior-art wrap. This is what makes the resident test
  unambiguous here rather than a close call.
