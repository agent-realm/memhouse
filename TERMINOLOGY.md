# Terminology — the canon

**This file is the source of truth for what things are called across the Ultimagent
constellation.** Every component repo carries a copy, plus a short section on how these terms
apply locally. If a word here disagrees with a word in a component, this file wins — open an issue
rather than diverging.

Last decided: **2026-10-10** — the canon's links are absolute (`https://github.com/agent-realm/ultimagent/blob/main/…`) so a verbatim copy resolves in every repo, the settled `filehouse` vs `clickhouse-fs` entry is removed from *Still open*, and the 2026-07-29 business sense of `operator` is marked superseded by the Society row. Before that:

**2026-10-08** — **reconciled with kernel v13 @ `5bfa695`** (the Hearth distro). The
pilot ruled *"continue with agreed by both. for the other calls, use your sense"*,
with the other calls delegated to agent-realm-lead [via agent-realm-lead]. What changed:

- **The kernel repo is canon for mechanism; this file is canon for names.** A kernel-introduced
  name enters here only through a canon PR. Every mechanism entry is one line plus a pointer
  pinned to a kernel version and commit, so a new kernel version shows up as a stale pin rather
  than as silent drift. See [The kernel — v13](#the-kernel--v13-mechanism-is-the-kernel-repos).
- **Added:** `<realm>_root`, `sudo` / sudoer, the `exec` and `sys` planes, primitive, the `root`
  and `lobby` houses, userhouse, settling, inbox, tenant, and **Hearth**.
- **Retired:** `kernel` as a principal, and **`governor`** as a principal or role word (see
  [Retired words](#retired-words--do-not-reintroduce)).
- **Amended:** `guest` (lobby-only), `member` (also the audience), `mayor` (the realm's first
  sudoer), and `operator` (its "= a human with sudo" gloss is gone).
- **The v6 mechanism line** — "`sys.exec` / `QueryRunner` — REMOVED", "a kernel verb is a
  `DEFINER` view" — is kept as **dated history**, because v13 reversed it.

Previously decided: 2026-08-04, kernel spec v6
([`KERNEL-SPEC-2026-08-04-v6.md`](https://github.com/agent-realm/ultimagent/blob/main/KERNEL-SPEC-2026-08-04-v6.md), now superseded).

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

Since kernel v13, **every realm is a tenant**: every object it owns is named `<realm>_`, so several
realms — and data belonging to none of them — share one town. In the machine register, always write
the prefixed form (`<realm>_root`, never a bare `root`); bare names are what tenancy removed.

| Town vocabulary | Machine vocabulary |
|---|---|
| **userhouse** | a house belonging to a person, named after them |
| **the lobby** | the `lobby` house — the optional front door, where an unauthenticated visitor asks to join |
| *(no town word)* | the `root` house — system rooms: what is grantable, what is running, what ran |
| **inbox** | `<house>.inbox` — the one room others may write to and not read |

## Society — who does things

| Town vocabulary | Machine vocabulary |
|---|---|
| **mayor** | the realm's **first sudoer** — a human. Machine register: `sudo`, holding `__<realm>_sudoer` |
| *(no town word)* | **`<realm>_root`** — the one all-powerful account **per realm**: everything on `<realm>_*.*`, nothing on a database it did not make. Privileged SQL runs as it. (*`kernel` as a principal is retired 2026-10-08, and `ego` before it; `kernel` now names the component, the repo and the distro line.*) |
| *(no town word)* | **sudoer** — the `__<realm>_sudoer` role: `INSERT` on the thirteen **primitives** by name, and **not** on `<realm>_exec.sql`, so deliberately less than root. **`sudo`** is the realm's first sudoer, held by a human; its town name is **mayor** |
| *(no town word)* | **`operator`** — a human who installs and maintains the realm, holding a personal credential. In v13: whoever secures the server's admin account and runs the boot. Holding `sudo` in the realm is a separate grant |
| **agency** | a house **plus the residents working in it** (see below) |
| **resident** | something that fires on a trigger and **writes** — a daemon, a scheduled view, an insert-triggered view. See the test below |
| **routine** | something that is **called and returns**, changing nothing — a view, a UDF, a parameterized view. House machinery, not a resident |
| **member** | a registered user with grants. **Caution:** `__<realm>_member` is also the **audience** — a grant to it reaches **every registered principal** (kernel `SCENARIO-v13` "The names") |
| **guest** | the `guest` user — anonymous. **Only if the realm opens the optional `lobby` house**, it reaches the lobby's public rooms **plus the one anon write** (the knock, on the lobby's register room) through grants made directly to `guest`. A realm with no lobby gives `guest` nothing |
| *(no town word)* | **principal** — any authenticated identity: member, resident, guest, `<realm>_root`, `operator`, `sudo` / mayor. Machine register only |

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

**The exception: routines that reach outside.** A routine writes nothing *inside* the database —
but a routine built over a **transport table function** (`url()`, `remote()`, `s3()`,
`postgresql()`) or an **executable UDF** can act *outside* it. Such a routine passes the mechanical
test and still carries a resident's blast radius. These are kernel-tier by
[substrate-conventions](https://github.com/agent-realm/ultimagent/blob/main/contracts/substrate-conventions.md) #10 and `[BW]`-gated behind
[iron-proxy](https://github.com/agent-realm/ultimagent/blob/main/components/iron-proxy.md) for exactly this reason.

*(Widened 2026-07-29 from "executable UDF" alone: `ultimagent-kernel` SPEC v9 §5.1 describes a
`url()` call as "a true one-round-trip syscall with **side effects**" — a POST that writes outside
the database. Same reach, same gate.)*

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
watches = "main.log"                      # required when on = "insert" — WHICH room fires it
```

`on = "insert"` is incomplete without a source: it says *that* a resident fires on an insert, never
*what* it fires on. **`watches` names the room — settled 2026-07-29.** It reads as a fact about the
resident rather than a pointer into the schema, and stays correct if the room is renamed. First
concrete use: a relay is `on = "insert"`, `watches = "<its request room>"`.

**`on` does not enter the kernel's install ABI** (decided 2026-07-29, `ultimagent-kernel`): the
kernel creates the *conditions* for residents, never residents themselves, and every trigger
resolves to the same install verbs. It belongs in the agency manifest, where it is material for
the **mayor's approval prompt** — "three residents, one on a loop holding an outbound credential"
tells a human more than "wants a house".

A house with **no `[[resident]]` at all** is a house, not an agency — the identity realm.

*(Say **resident**, and let the keys carry the variation. "Resident program", "resident code",
"resident trigger" multiply vocabulary for one concept; a resident with `on = "insert"` says it
precisely.)*

## Things you ask for

| Town vocabulary | Machine vocabulary |
|---|---|
| **asking for something** | a request row in a `<realm>_sys.*` table — the **sys plane**: insert it, and it waits for someone who may decide |
| **doing what you are granted** | a row in a `<realm>_exec.*` table — the **exec plane**: insert it, and it runs |
| **joining** | knock and claim in the lobby → the kernel mints the principal and its house |
| **settling** | moving into a realm: the kernel provisions the house, an agent furnishes it |
| **what you may do** | `GRANT`s and row policies — *capability = exactly the grants* |
| **the lobby** | the `lobby` house — what the realm is, its rules, who lives here, and the knock (exact rooms: kernel `SCENARIO-v13`) |
| **the front page** | the `_index` table (+ `_rules`) |
| **your keys** | named collections you can use but not read |
| **the schedule** | timers, ticked by a refreshable materialized view |

## Machine-only — never use these outward

`argMax` · append-only · snowflake cursor · Backend B · cursor seam · the catalog · syscall ·
`MATERIALIZED currentUser()` · `ROLE ADMIN` · `<agency>_root` · `<realm>_root` · `__<realm>_sudoer` ·
`__<realm>_member` · `<realm>_exec.sql` · the `exec` / `sys` planes · primitive · `QueryRunner` ·
**routine** · processor
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
| **Hearth** | the distribution that stands a realm up — the kernel, packaged (`Hearth 0.1` = kernel v13) |

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
| **agent-house** | **town**, or "my realm" | it named a whole deployment, but a house is one unit *inside* a town. *Kernel v13's docs use **agenthouse** (a userhouse that has residents): read it as **agency**. Not adopted (2026-10-08) — it is doc-only in the kernel, one hyphen from this retired word, and the canon word for a house with residents is already agency* |
| **Mayor as the *provisioning executive*** | **`<realm>_root`** (v13; formerly the `kernel` user, and `ego` before that) | provisioning is `<realm>_root`'s job. **Narrowed 2026-07-29** — the earlier form retired "Mayor as a ClickHouse user" outright, which the governor decision *(2026-07-29, before governor was retired)* contradicts: a mayor is a human holding a *real personal credential*, and on ClickHouse a human's credential **is** a ClickHouse user. `CREATE USER mayor` is a human login, not a violation |
| **`kernel`** *(as a principal)* | **`<realm>_root`** | retired 2026-10-08 — v13 makes the all-powerful account per realm, a tenant. `kernel` still names the component, the repo and the distro line |
| **`governor`** *(as a principal or role)* | **`sudo`** / **`__<realm>_sudoer`** (machine register); **mayor** (town register) | retired 2026-10-08 — it meant "same power as `kernel` + the approver", and v13 splits those: `<realm>_root` holds the power, and the sudoer approves while deliberately **lacking** root's (no `<realm>_exec.sql`). Carrying "same power as root" into the sudoer would change its meaning silently. `governor` as a *component* (governance-as-compiler) stays deferred under `realms` — **rename it when built** |
| **participant** | **principal** (machine register); *member* or *resident* when speaking to a member | retired 2026-07-29 — meant "member or resident", a set nothing needed |
| **memorecall** | **`/mem:recall`** | retired 2026-07-29 — the shipped skill is `/mem:recall` (`mem-recall` on agents without namespacing), installed in production. The canon follows what people actually type |

The `agent-` prefix does no work — in an Agent Realm everything is agent-something.

---

## The kernel — v13 (mechanism is the kernel repo's)

**The kernel repo is canon for how things work; this file only names them.** Each entry is one line
plus a pointer, pinned to **v13 @ `5bfa695`** in [`agent-realm/kernel`](https://github.com/agent-realm/kernel),
`SCENARIO-v13-2026-09-15.md`. When the kernel moves past v13, these pins go stale visibly, and
updating them is a canon PR.

- **exec plane** — `<realm>_exec.*`: insert a row and it runs, as `<realm>_root`. *(v13 @ `5bfa695`, Part 2)*
- **sys plane** — `<realm>_sys.*`: insert a request and it waits for an approver. It holds request
  tables for **twelve** of the thirteen primitives (`exec.grant_verb` has none), and **nothing**
  mirrors `<realm>_exec.sql`. *(v13 @ `5bfa695`, step 8)*
- **primitive** — one of the thirteen privileged operations, each a table in `exec`; the sudoer
  holds `INSERT` on them by name. *(v13 @ `5bfa695`, "The names")*
- **`<realm>_exec.sql`** — root's own hands: ordinary SQL run as `<realm>_root`, granted to no role
  the realm mints. *(v13 @ `5bfa695`, "The names")*
- **`QueryRunner`** — the engine of the exec plane. The kernel's floor is ClickHouse **26.8**
  *(v13 @ `5bfa695`, step 1)*. An upstream bug, **ClickHouse #119848**, skipped all privilege checks on the
  queries it runs; it is fixed in **26.8.7.19+**. v13 does **not** depend on the fix, because it
  grants the raw runner to no role (kernel `DEFERRED.md` @ `14aff49`, *QueryRunner did not check the privileges
  of anyone*). A patched release is still recommended.
- **tenant** — a realm; every object it owns is `<realm>_`-prefixed. *(v13 @ `5bfa695`, "Every realm is a
  tenant")*
- **settling** — moving into a realm: the kernel provisions the house, an agent furnishes it.
  *(v13 @ `5bfa695`, Part 3)*
- **agenthouse** *(kernel docs only)* — read as **agency**; not a canon word. *(v13 @ `5bfa695`,
  "The names"; see [Retired words](#retired-words--do-not-reintroduce))*

## History — the v6 operator model (settled 2026-08-02, superseded 2026-10-08)

> **Dated history, not live canon.** Kernel v13 reversed the mechanism this section describes:
> `QueryRunner` is back as the engine of the exec plane, a verb is a table you `INSERT` into, and
> `kernel` and `governor` are retired as principal words. Kept so the record of how the design was
> reached stays readable. For what runs now, see
> [The kernel — v13](#the-kernel--v13-mechanism-is-the-kernel-repos).

Source: [`KERNEL-2026-08-03-v7.md`](https://github.com/agent-realm/ultimagent/blob/main/history/KERNEL-2026-08-03-v7.md), verified live on ClickHouse
`26.7.1.1315`.

- **`ego` is retired.** It was the town-register name for *"the `kernel` ClickHouse user"* — a town
  word for something no townsperson ever addresses. Read every `ego` as **`kernel`**. The
  `ego`-vs-`kernel` disagreement between `substrate-conventions` #9 and kernel SPEC v9 is settled
  **per mechanism** rather than abolished (#9, amended 2026-08-03): under `sys.exec` the invoker
  *is* the principal and there is no separate provisioner; under the `executable()` mechanism that
  serves `sys.calls` there is one, running on a stored credential, and #9's trusted-executor
  assumption applies to it in full.
- **Three roles, split by function, not by register.** **`kernel`** (= `root`) is the identity the
  machinery is created by and runs as; its credential is spent at install and dormant after — **but only once nothing still logs in as `kernel`**; a realm keeping the legacy `sys.calls` dispatcher must defer that retirement (v7 §17.1),
  retired with **`ALTER USER kernel HOST NONE`** — never `IDENTIFIED WITH no_password`, which makes
  the user loginable by anyone — and recoverable only through the server's `users.d` on disk. **`operator`**
  installs and maintains the realm and drives its verbs through capability views, holding a
  *personal* credential so
  `currentUser()` answers *which human did this*. **`governor`** is the business authority
  (`GRANT ALL ON *.* WITH GRANT OPTION`), created *by* an operator — as root creates a user and
  grants them ALL in sudoers. `mayor` remains the governor's town name.
- **`operator` now carries both registers.** It keeps its 2026-07-29 sense — the business that runs
  a realm — and gains the machine sense above. The business employs operators; each holds their own
  credential. No collision: one is a company, the other its people.
- **Execution mechanisms are open-ended, not a fixed set** (amended 2026-08-04; v7 §18 said "four"
  and the letters `A`–`D` are retired as names). They are positions in a six-axis space — trigger ·
  blocking · answering · executor identity · requester identity · delivery — and permission is
  *derived*, not chosen. New ones are admitted when a position is genuinely reachable; **name them
  by what they do, never by a letter.** Chosen per verb:
  - **`DEFINER` view** — privileged reads, no process and no stored secret.
  - **`executable()` handler**, behind a `DEFINER` parameterized view — **the default for a kernel
    verb since v6.** The only mechanism that performs an effect *and* answers, and the only one that
    can inspect step 1 before running step 2, or pause to ask a human. May answer synchronously or
    detach and hand back a receipt. Costs: `system.query_log` names the handler, not the requester,
    and it spawns one process per call, so `max_concurrent_queries_for_user` is mandatory. Serves the built `sys.calls` mailbox, supplying authority members lack and writing the
    correlated `sys.call_results` row. **The only mechanism that stores a credential**, so a
    credential-sensitive *read* verb belongs on a `DEFINER` view instead.
  - **the relay** — an insert-triggered materialized view that transforms a caller's request row
    into a write on a table they cannot write. Effects with no credential *and* no SQL string, so
    it has **no injection surface**; it sees only rows inserted after it exists.
  - **`sys.exec` / `QueryRunner` — REMOVED 2026-08-04** (kernel spec v6). A verb assembled from
    `format()` templates and dispatched through a runner is the v5 design. Its at-most-once queue,
    completion markers, per-argument identifier regex and global serialisation point went with it.
  - **the dispatcher** — a refreshable materialized view over a backlog: the only mechanism that
    sees rows written before it existed, and that retries.
  - **the clock** — a refreshable materialized view running privileged work on a schedule with
    **no requester and no executor identity at all** (`query_log` records `user = ''`), so
    everything it may ever do is fixed at `CREATE` time by whoever wrote the view.
    [`kron`](https://github.com/agent-realm/ultimagent/blob/main/components/kron.md) is this mechanism.

  `eval()` inside a `DEFINER` view is **not** a mechanism — it is a hazard with a mechanism's shape,
  banned outright: it reads anything the definer can and the caller cannot opt out via settings.
- **The built `sys.calls` mailbox is served by an `executable()` handler.** A member's
  `INSERT` is authorised per verb by a `CONSTRAINT` consulting a `(principal, ref)` ACL table —
  on the *requester*, at insert. A **refreshable MV** is the dispatcher: it selects calls with no
  terminal result — it does **not** claim them, and there is no lease — calls `executable()` as a
  trusted executor, and writes the correlated `sys.call_results` row. Delivery is therefore
  **at-least-once and unbounded**: a crash, an empty handler result, or a `pending` status leaves
  the same call eligible on the next refresh. `sys.exec` is **not** on that path — it executes as
  the caller, so it cannot perform the privileged mailbox verbs nor return a result.
  **The wiring is not ready to deploy** (v7 §18.8): it needs a KeeperMap CAS lease and a deployed
  verb catalog first. The assignment of the mailbox to mechanism B is settled; the migration is not.
- **(RETIRED v6) A `sys.exec` syscall is an `INSERT`** — that table is a *separate* execution layer, for callers
  who want caller-attributed execution and no stored credential. The engine executes with
  `SQL SECURITY INVOKER` — *as the user who inserted it* — so identity stamping survives the queue
  natively. **Enqueueing confers no privilege, with one measured exception:** `CREATE` of new
  objects (database / table / view) bypasses the grant check, so grants alone do not gate which
  syscalls a principal may make. Admission is gated by **`GRANT INSERT` on a request table** plus a
  typed `verb` `Enum`; `CONSTRAINT` validates *arguments* and is the **only** error channel the
  caller hears — execution failures are silent, visible only in `system.query_log`.
- **`IMPERSONATE` leaves the everyday path.** Convention #11 stands, but its one irreducible use is
  **migration** — rows that must keep their original owner's `MATERIALIZED currentUser()` stamp.
  Granted per operation, revoked after; no standing grant on a dispatcher.

## Settled 2026-07-29

- **`principal`** is the machine-register umbrella for any authenticated identity — member,
  resident, guest, `kernel`, `operator`, mayor *(2026-10-08: `kernel` → `<realm>_root`; see the
  Society table)*. **`participant` is retired**: it meant "member or resident", a
  narrower set nothing actually needed. There is deliberately **no town word** — to a member the
  difference between a person and a daemon matters, so say *member* or *resident*.
- **`watches`** is the key naming an `on = "insert"` resident's source room. Name settled.
- *(v6 — superseded 2026-10-08 by v13's `sys` and `exec` planes.)* **`sys.calls` / `sys.call_results`** are the syscall tables, not `sys.syscalls`.
  `ultimagent-kernel` is built on them (`sql/00-sys-shape.sql`, `GRANT INSERT, SELECT ON
  sys.calls TO member`); kron's `sys.syscalls` was design-only. **Built beats designed.** kron
  changes, and its `INSERT ON sys.syscalls` security literal moves in the same commit.
- **`clickhouse-fs` dissolved** into [filehouse](https://github.com/agent-realm/ultimagent/blob/main/components/filehouse.md); `fs-sql` stays separate.
- *(2026-10-08: superseded. `operator` is the human who installs and maintains the realm, who in v13 secures the server's admin account and runs the boot; see the Society row. The business that runs realms for itself or for clients has no settled word yet; see Still open.)* **`operator`** is the business that runs a realm — for itself or for clients. Already the word
  used across the docs ("operator-facing", "operator-run realm"), and it scales from one human to
  a company without changing meaning. This is the sense `agency` used to carry.
- *(Retired 2026-10-08 as a principal word — see Retired words.)* **`governor`** names the **human authority** who owns a realm — same power as the `kernel` user,
  different personal credential, and the approver some operations require. **`mayor` is its
  town-register name**, chosen per realm; another realm may pick *emperor*. `governor` as a
  *component* (governance-as-compiler) is **deferred** — that job is `realms`'.
- **Deferred, on purpose.** These are words or unbuilt surfaces. None blocks code; all are a `sed`
  or a new file away later. Do not re-open them unprompted:
  **the approval mediator** (the tool that asks the governor to approve — Telegram or otherwise —
  and returns the verdict) · **standing approval policy** (`sys.approval` records one verdict per
  call, with no place for "always allow this agency this request"; additive schema when needed) ·
  **"the guest house beside company.com"** (collides with `guest` and `house`; lives in
  `DELIVERY-2026-07-13-v2.md`, the visual essay, and slate-tr's unmerged integration branch —
  **trigger: resolve before it goes in front of anyone outside**, i.e. before D0 or D5).
- *(Amended 2026-10-08: in v13 this write exists only where the realm opens the optional `lobby`
  house — see the Society table.)* **`guest` was defined too narrowly and is corrected.** It read "`SELECT` on the lobby only" —
  but the register advertises **join** as one of three ways in, and a lobby-read-only principal
  cannot register. `guest` holds the **one anon write**: `INSERT` on the register room. This is
  the C2 resolution already recorded as *verified* in
  [substrate-conventions](https://github.com/agent-realm/ultimagent/blob/main/contracts/substrate-conventions.md), and it is what the
  bell-labs-cafeteria schema grants its `anon_reader`. A realm provisioned to the old wording
  would fail the explorer's join flow. Found by `ultimagent-explorer`, 2026-07-29.

## Still open

Kept visible on purpose; a glossary that hides unresolved naming is how drift enters.

- **The business that operates a town.** `agency` now means a working house *inside* a town, so
  the town-scale operator (the Foundry / hosting customer) needs its own word.
- **"Agent Realm"** is the product category. Any older text defining it as "a realm whose residents
  are LLM agents" is stale — `[[resident]].kind` already carries that.
- ~~**The identity realm is a shipped counter-example to "the governor has the same power as the
  `kernel` user."**~~ **Resolved 2026-10-08:** v13's sudoer is least-privilege by construction —
  it lacks `<realm>_exec.sql` — which is the identity realm's content-blind mayor generalised.
  `governor` is retired as a principal word. Kept below for the record:
  **The identity realm is a shipped counter-example to "the governor has the same power as the
  `kernel` user."** Its `mayor` is deliberately **denied `SELECT` on `main.log`** and reaches
  content-blindness through `ROLE ADMIN`, not through a closed catalog — a verified least-privilege
  construction on CH 26.6.1. Evidence that the ch. 0021/0022 reading works and is cheap. Bears on
  #9's amendment; found by `realms`, 2026-07-29.
- ~~**`substrate-conventions` #9** still describes the `ego` as a least-privilege provisioner…~~
  **Resolved 2026-08-03, per mechanism.** Under **`sys.exec`** (`QueryRunner`, `INVOKER`) there is
  no separate provisioner — the principal who enqueues a syscall is the principal it runs as. Under
  the **`executable()`** mechanism that serves `sys.calls`, there is: the handler runs on a
  **stored credential**, so #9's trusted-executor assumption applies in full, with multi-tenancy as
  its stated trip-wire. Content-blindness is in both cases a property of the closed catalog having
  no content-read verb, not of a role's grants. **#9 was amended accordingly on 2026-08-03** — it now carries the per-mechanism executor table and scopes the trusted-executor assumption to the `executable()` path. Nothing outstanding here.
- **`governor`** — retired as a principal word on 2026-10-08. The component card stays deferred
  under `realms` (rename when built). Still open: [`trust`](https://github.com/agent-realm/ultimagent/blob/main/contracts/trust.md) and
  [`secrets`](https://github.com/agent-realm/ultimagent/blob/main/contracts/secrets.md) name `governor` as a consumer; re-read them against v13 (the
  sudoer) when each contract is next revised.
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

This copy is held at umbrella TERMINOLOGY @ a8a59cd (2026-10-10); the next sync picks up later changes.

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
| **room** | a table in a house — `sessions`, `messages`, `tool_calls` — one set per member and named for them (`mem.polat_messages`). A member holds one grant, on `mem.polat_*`, and nothing else in the database; nobody is granted the database itself. `user_id MATERIALIZED currentUser()` says who wrote a row in either. The 0.4.0 shared-tables-with-row-policies and 0.8.0 `sessions_<m>` layouts are both retired — see `memhouse/DESIGN.md`. `meta` / `events` are **not** rooms — they are the house's record of itself |
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
