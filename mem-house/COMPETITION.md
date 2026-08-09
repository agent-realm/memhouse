# mem-house — the competition

Companion to `DESIGN.md`. That file states **the four bets**; this one grades each
bet against the field as it actually stands.

**Surveyed 2026-08-07.** Every star/fork/date figure was pulled from the GitHub API
on that date and is a decaying fact — re-run before citing. Claims that could not be
verified are marked *unverified* rather than asserted. X/Twitter was not reachable
(HTTP 402 to the fetch tool), so nothing here reflects it.

The finding, in one line: **three of the four bets are already occupied by shipping
competitors, most of them free and further along. Bet 3 is the one that holds.**

---

## The field splits four ways

The space shares vocabulary but not architecture. Distinguishing the camps is the
whole analysis, because most "agent memory" products are not competitors at all.

| Camp | What it means | Where memory comes from | Competes with us? |
|---|---|---|---|
| **Transcript readers** | Index the JSONL/SQLite stores the agents already wrote | Passive — reads disk | **Yes, directly** |
| **Hook capturers** | Install lifecycle hooks, compress with an LLM, re-inject | Passive, but must live inside the agent | Yes, on the same users |
| **Memory SDKs** | Developer calls `add()` / `search()` | Active — the developer writes it | No — different product |
| **Observability** | OTel/proxy traces of model calls | Passive, at the API layer | Only on analytics |

mem-house is a transcript reader with the observability camp's analytics attached.
That combination is the most defensible thing about the product's *shape*; the
individual pieces are not scarce.

---

## The four bets, graded

### Bet 1 — Parse on the client. **Occupied. Not differentiated.**

The reasoning in `DESIGN.md` is sound and the conclusion is correct — sqlite-backed
editors do force client-side parsing. But it is no longer a distinguishing choice.
At least five projects crack the same on-disk stores today, and one of them cracks
formats we do not touch (encrypted Protobuf sidecars for Antigravity CLI, Markdown
for aider).

Editor coverage — the number we lead the README with — is mid-pack:

| Project | Editors | Note |
|---|---:|---|
| AgentsView | **50+** | each with documented on-disk paths |
| lean-ctx | 30+ | claimed |
| CCHV | 28 | each with documented paths |
| **mem-house** | **17** | |
| deja-vu | 17 | different 17 — has Cline, aider, Qwen Code, Kimi Code, Roo Code |
| coding_agent_session_search | 11+ | |
| ctx | 8 | |
| Conare | 7 | |
| Contextify | 2 | Claude Code + Codex CLI only |

deja-vu's tagline is our pitch verbatim: *"it indexes the sessions your coding agents
already wrote to disk, months of history from before you installed it, across
seventeen harnesses."*

### Bet 2 — Typed common schema. **Occupied on outcome, distinct on method.**

Everyone arrives at structured storage; the axis that still separates us is **when
the extraction happens and what survives it**.

- **SQLite + FTS5 is the category default**, reached independently by AgentsView,
  Agent Sessions, claude-code-chat-explorer, claude-mem, ccrecall and mnemo.
- **ClickHouse for editor transcripts is unclaimed.** The only other ClickHouse-based
  agent memory found is `clickmem` (57 stars) and it is embedded chDB, single-user,
  so it inherits none of the multi-member properties. Langfuse is ClickHouse-backed,
  MIT and self-hostable — but ingests API traces, not editor stores.
- **Verbatim-with-no-LLM-on-the-write-path has one serious co-traveller**:
  MemPalace (58k stars in four months) sells exactly that — *"verbatim storage,
  zero API calls."* We are not alone on this axis, but the company is good.

Honest caveat: at single-team scale SQLite demonstrably suffices. ClickHouse is a
bet on a scale we have not yet had to prove.

### Bet 3 — Kernel-installable agency, own-only by absent grant. **This one holds.**

This is the finding worth acting on. Every competitor's multi-user story is a
**shared pool** or **metadata scoping**. Not one enforces isolation at the
datastore's own permission layer.

| Product | Team mechanism | Isolation |
|---|---|---|
| AgentsView | `pg push` / `pg serve` to shared PostgreSQL | **None.** Connection string is the whole boundary; `machine_name` is a label, not a fence |
| memsearch (Zilliz) | Docker + shared Milvus, documented "for team environments" | **None documented** — no RBAC, no per-user namespacing |
| mem0 | `user_id` + `agent_id` + `run_id` filters | Metadata filtering, not enforcement |
| Industry pattern | `tenant_id` column + row-level security | Policy layer, revocable by whoever owns the policy |
| Contextify | Cloud workspace, per-project opt-in | Real, but proprietary, cloud-first, 2 editors |
| **mem-house** | three `GRANT SELECT` on the member's own rooms | **A member cannot name another member's rooms.** `WITH GRANT OPTION` on `SELECT` and not on `ALL` makes sharing read-only by construction and operator-free |

Bet 3 is not a niche preference. It is a category-wide blind spot, and it is the
only thing in this document that nobody else is attempting.

### Bet 4 — Borrowed UI, zero fork. **Occupied. Not differentiated.**

Analytics over the same files is a crowded, mature niche: ccusage (17.8k stars),
CodexBar (19.8k). Agent Sessions beats us on the analytics *idea* with a per-session
"Quota Meter / Session Runway" priced per model against 5-hour and weekly windows.
AgentsView ships cache-aware, LiteLLM-priced cost reporting plus a REST usage API.

Zero-fork was the right call for build cost. It buys no position.

---

## The field, ranked by how directly it competes

| # | Project | What it is | Source | Store | Team | Editors | Licence | Signal (2026-08-07) |
|---|---|---|---|---|---|---:|---|---|
| 1 | **AgentsView** | Go binary + Tauri app + Docker image | reads disk | SQLite/FTS5, opt. DuckDB, opt. **PostgreSQL** | shared pool, free | 50+ | MIT | **4,723★**, 574 forks, 100 contributors, six months old, MCP server, semantic search |
| 2 | **claude-mem** | npm plugin + MCP + web viewer | **hooks** | SQLite + Chroma, opt. cloud | none | ~8 | Apache-2.0 | **89,967★**, 7,831 forks, **62,940 npm dl/mo**. The category's centre of gravity |
| 3 | **MemPalace** | local-first memory, verbatim | mixed, mining transcripts | pluggable | none | — | MIT | **58,182★ in four months**, 696 open issues, contested benchmarks |
| 4 | **deja-vu** | zero-dep Go binary, CLI + MCP + hook | reads disk | `records.bin`, no server | none — personal SSH sync | 17 | MIT | 593★, HN 131 pts, redacts secrets at index |
| 5 | **Contextify** | macOS app + CLI, cloud **and** self-hosted | reads disk | local + optional cloud | **real**: seats, roles, per-project opt-in | 2 | proprietary / FSL | $8–15/seat/mo; self-host $132/seat/yr |
| 6 | **ctx** | Rust CLI, event-level provenance | reads disk | local SQLite | **ctx cloud**, hosted, private beta | 8 | Apache-2.0 | 1,013★ |
| 7 | **SpecStory** | IDE extensions + CLI | **writes its own** | local + cloud | team rollups | 9 | Apache-2.0 | 1,296★; **Team $300/mo**; "Lore" mines history into installable skills |
| 8 | **Conare** | CLI + hosted, MCP | reads disk | vendor cloud | shared memory, audit logs, SSO | 7 | proprietary | **Team $500/mo** |
| 9 | **memsearch** | Markdown + Milvus shadow index | Stop hooks | Markdown truth + Milvus | Docker, no isolation | 4 | MIT | 2,431★, Zilliz-backed |
| 10 | **CCHV** | Tauri app + **headless server** | reads disk | provider files + cache | server mode w/ accounts | 28 | MIT | 2,020★, 45 contributors |
| 11 | **Agent Sessions** | native macOS app | reads disk | SQLite/FTS5 | none | 10 | MIT | 762★; best-in-class quota metering; resume + write-back restore |
| 12 | **ContextPool** | CLI + MCP | reads disk | local + repo dir | shared pool, $7.99/mo | 4 | mixed | 188 PH upvotes |

Adjacent and **not** competitors, but they own the vocabulary and the capital:
mem0 (62.8k★, $24M), cognee (29.8k★), graphiti (29.6k★), supermemory (28.8k★),
letta (24.1k★, $10M seed), memori (15.7k★), OpenViking (28.1k★, ByteDance),
Hindsight (19.2k★, $3.6M seed). All of them require the developer to write the
memory. None ingest agent sessions.

---

## What they do better

- **Distribution.** mem-house: 0 stars, 655 npm downloads/month, no HN or search
  presence. claude-mem: 89,967 stars and 62,940 downloads/month, free, no company.
  This dominates every other consideration in the document.
- **Automatic recall.** deja-vu installs a SessionStart hook; claude-mem injects into
  future sessions; ContextPool loads at session start; SpecStory converts history
  into *installed skills*. Our skills must be chosen. One independent analysis of 270
  real sessions found **only 4.8% involved an explicit history query** — a pull-only
  model gets invoked rarely.
- **Install weight — we are the heaviest in the category.** AgentsView, deja-vu and
  ctx are single dependency-free binaries via Homebrew, Docker, `go install` or curl.
  We are Node, need `--allow-scripts=better-sqlite3` (five adapters silently read
  nothing without it), and additionally need a ClickHouse to point at. Our README
  spends paragraphs on `EACCES`/`sudo` triage. That is a real adoption tax.
- **Semantic search.** AgentsView (opt-in index), claude-mem (Chroma),
  claude-history (local embedding model). We are FTS-only. Contested rather than
  settled — deja-vu made the same choice and was criticised for it on HN.
- **Secret redaction at ingest.** deja-vu redacts credential patterns on index *and*
  on sync export. Whether we do is *unverified* — and it matters more here than
  elsewhere, because Claude Code caches unredacted secrets in transcripts
  (anthropics/claude-code#43675) and we ship those rows to a shared server.
- **Resume and write-back.** Agent Sessions copies resume commands for six CLIs and
  restores into the archive; claude-history resumes *and forks* worktree-aware. We
  read but do not hand the pilot back in.
- **Price ceiling.** AgentsView gives the whole stack away under MIT. That caps what
  a self-hosted OSS competitor can charge for.

---

## Unclaimed ground

Two positions nobody occupies, both reachable from where we already are.

**1. Evidence and claims as two layers.** The sharpest architectural critique found
anywhere in the survey, and no product in the field claims to do it: keep the capture
log and the memory layer distinct. The capture log is chronological evidence; memory
is a set of derived, revisable claims. Each claim cites the exact spans supporting
it, records when it was inferred, and marks itself current, disputed or superseded —
and deletion follows that lineage. This is available **only** to a system that keeps
verbatim transcripts with provenance. Every extract-only competitor has discarded the
evidence by the time the claim is written. We and MemPalace are the two systems
positioned to build it. Neither has.

**2. The 30-day deletion window.** Claude Code deletes JSONL transcripts after 30
days. Contextify was built because of it; vibe-replay documents it; **nobody markets
on it.** A durable server-side store is the strongest possible answer, and we are
better positioned than any local-index tool. This is free ground.

---

## Three cautions

**Do not compete on benchmark scores.** The benchmarks are broken. An independent
LOCOMO audit found 99 score-corrupting errors in 1,540 questions (6.4%), and the
standard LLM judge accepted 62.81% of adversarially-generated wrong-but-topical
answers. Nine vendors claim mutually incompatible SOTA on it. MemPalace's claimed
100% was reverse-engineered publicly to 98.4%, achieved with `top-k=50` — which
exceeds the session count. deja-vu's 84.9% hit@1 carries the same asterisk. Entering
this contest means measuring the field against itself.

**Stars are not traction, and are farmed in this category.** `mindverse/Second-Me`
holds 15,648 stars and has been dead for ten months. MemPalace took 58k stars in four
months while accumulating 2,183 issues, one titled *"in short: This sucks shit."*
Screenpipe reportedly mails its stargazers.

**The free incumbent sets the floor.** claude-mem is Apache-2.0, free, no cloud tier,
no company, one dominant author. Any paid or heavier-install offering is measured
against that baseline, not against a vendor's price list.

---

## Net position

Not differentiated on parse-on-client, editor breadth, self-hosting, analytics, or
agent-facing skills — all matched or beaten, most comprehensively by AgentsView
(MIT, free, 50+ editors, 4,723 stars, six months old).

Two things hold: **grant-enforced per-member isolation**, which nobody attempts, and
**verbatim transcripts with provenance**, which is the prerequisite for the
evidence/claims separation the field has identified but not built.

The liabilities are zero distribution and the heaviest install in the category.
Both are fixable; neither is fixed by adding another editor adapter.
