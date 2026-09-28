# The house — connect, schema, and the three things that bite

Read this before writing any query. Every `/mem:*` skill points here rather than
repeating it, so there is one description of the store and it is either right everywhere
or wrong everywhere.

---

## What this is

A **house** is a ClickHouse **database** — on the user's machine, their server, or a
hosted ClickHouse; memhouse runs no service of its own. Its **rooms** are tables —
`sessions`, `messages`, `tool_calls` — and the server stamps who wrote every row. A
house's grants reach nothing outside it.

Every member's rooms are named for them — `mem.alice_messages`, `mem.alice_sessions`,
`mem.alice_tool_calls` — and one grant covers exactly those: `ON mem.alice_*`. Housemates
keep their own rooms beside yours and cannot read them, list them, or grant them onward;
you cannot read theirs. `SHOW GRANTS` shows you the one line you hold. **A bare
`FROM messages` names nothing you have** — the `q()` below prefixes room names with your
member name for you, and `memhouse rooms` prints what yours are called.

An **operator** owns the ClickHouse itself; an **admin credential** is what proves it.
`memhouse whoami` says which you are holding.

Rows arrive from a **shipper** that parses local transcripts from 17 editors. It only
ever inserts. Nothing in memhouse runs an LLM over your data — these skills retrieve
rows, and *you* read them.

---

## Connect

**Never print this file or the variables in it.** No `cat "$MH_ENV"`, no
`env | grep MEMHOUSE`, no `set -x`. Anything printed becomes part of a transcript
memhouse ships back into the house — the archive is insert-only, so a leaked credential
cannot be withdrawn.

**Which memhouse.** `plugins install` stamps two variables into this config directory's
`settings.json`, so every session here carries them: `MEMHOUSE_HOME` is the instance whose
house these skills read, and `MEMHOUSE_BIN` is that instance's binary. **Every `memhouse …`
command in these skills means `"${MEMHOUSE_BIN:-memhouse}"`.** A machine can run two
instances on two channels; the bare name would be whichever the shell found first. Do not
override either variable.

Credentials resolve **flags > exported `MEMHOUSE_*` > `$MEMHOUSE_HOME/env`** (default
`~/.memhouse/env`) — the same order the CLI uses. The dance below snapshots the
environment first, because sourcing the file would otherwise clobber an already-exported
variable.

```bash
MH_ENV="${MEMHOUSE_HOME:-$HOME/.memhouse}/env"
_u=${MEMHOUSE_URL-}; _s=${MEMHOUSE_USER-}; _p=${MEMHOUSE_PASSWORD-}; _d=${MEMHOUSE_DB-}
set -a; [ -f "$MH_ENV" ] && . "$MH_ENV"; set +a
[ -n "$_u" ] && MEMHOUSE_URL=$_u; [ -n "$_s" ] && MEMHOUSE_USER=$_s
[ -n "$_p" ] && MEMHOUSE_PASSWORD=$_p; [ -n "$_d" ] && MEMHOUSE_DB=$_d
if [ -z "${MEMHOUSE_URL:-}" ] || [ -z "${MEMHOUSE_USER:-}" ]; then
  echo "no memhouse house configured — run: memhouse install" >&2; exit 1
fi

q() {  # read-only by construction; every read path should use this
  sed -E "s/([[:space:](]|^)(FROM|JOIN)[[:space:]]+(sessions|messages|tool_calls|meta|events)([[:space:];,)]|\$)/\1\2 ${MEMHOUSE_USER}_\3\4/g" \
  | curl -sS --fail-with-body --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
    --data-binary @- "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-$MEMHOUSE_USER}&readonly=1"
}
q <<'SQL'
SELECT 1 FORMAT PrettyCompact
SQL
```

`readonly=1` is a ClickHouse-side setting: even a mis-generated `DROP` is refused by the
server, not by discipline.

**The `sed` is what makes every query below work in both layouts** — write room names
bare and it supplies the prefix when there is one. It rewrites only after `FROM`/`JOIN`,
so a needle like `LIKE '%messages%'` is untouched, and `FROM yigit_messages` is left
alone — the room name must follow whitespace, and there is none inside `yigit_messages`.
With no prefix set it expands to nothing and the query passes through verbatim.

It is spelled with `[[:space:]]` classes rather than `\b` because **BSD `sed` does not
support `\b`**: on macOS the `\b` form matched nothing and sent the query through
unprefixed. That fails loudly as `UNKNOWN_TABLE` rather than quietly reading wrong rows,
which is the right way round — but it fails.

**Reading a housemate's memory.** A share is `GRANT SELECT ON mem.<them>_*` — their
rooms, not the database. `SHOW TABLES` lists exactly what you may read: your own rooms plus
any shared with you. Name a housemate's rooms in full (`FROM yigit_messages`); the `q()`
rewrite leaves an already-prefixed name alone, since applying yours would point at the
wrong rooms. Say whose memory an answer came from.

---

## Schema

**Subagents (forks) live inside their parent session.** Claude Code writes them to
`<session>/subagents/agent-<id>.jsonl` (Agent tool) and
`<session>/subagents/workflows/wf_<id>/agent-<id>.jsonl` (Workflow runs); the shipper folds them into the parent with
`is_subagent = 1` and stamps *which* one in `extra.agent`. Looking for a fork as its own
session finds nothing — look inside the parent:

```sql
-- the subagents a session spawned
SELECT toString(extra.agent.id) AS agent, any(toString(extra.agent.description)) AS asked_to, count() AS turns
FROM messages WHERE session_id = '<sid>' AND is_subagent GROUP BY agent   -- toString: a JSON path cannot be a GROUP BY key
-- one subagent's transcript, in order
SELECT seq, role, substring(text, 1, 2000) FROM messages
WHERE session_id = '<sid>' AND extra.agent.id = '<agent>' ORDER BY seq
```

**`messages`** — one row per turn.

| column | meaning |
|---|---|
| `session_id` | `<source>:<adapter-local id>`, e.g. `claude-code:6b1f…` |
| `seq` | order within the session. The session's own turns are `0, 1, 2, …`; a subagent's turns sit in their own block, `1,000,000,000 + slot × 100,000 + turn` (slot = the subagent's rank by start time), so `seq` is **sparse** — count rows with `count()`, never `max(seq) + 1` |
| `source` | editor: `claude-code`, `codex`, `cursor`, … |
| `host` | the machine, `<hostname>-<8 hex>` — random per install, not derived |
| `ts` | when the turn happened (`DateTime64(3,'UTC')`) |
| `role` | `user`, `assistant`, `system` |
| `is_subagent` | 1 for a turn that a Claude Code **subagent** (a fork) produced; folded into the parent session after the parent's own turns, each subagent's turns contiguous and the subagents in the order they started. Subagents are never separate sessions. |
| `extra` | JSON. For a subagent turn: `extra.agent.id`, `extra.agent.description` (what the parent asked it to do, else the fork's own first prompt), `extra.agent.type` (`general-purpose`, `workflow-subagent`, …), `extra.agent.turn` (position within that subagent), and `extra.agent.workflow` (`wf_…`) when a Workflow run spawned it. Empty `{}` otherwise, and on rows shipped before 0.18.3. |
| `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | usage; **empty for several adapters** — see below |
| `text` | the turn, **truncated at 50,000 chars** |
| `text_ngram`, `text_word` | `MATERIALIZED lower(text)`, carrying the text indexes |
| `project`, `folder` | where it happened; `folder` is what `resume` needs |
| `user_id` | `MATERIALIZED currentUser()` — stamped by the server, unfakeable |
| `origin` | `ship` or `import` |
| `epoch` | which *parse* of the session this row belongs to |

**`tool_calls`** — `session_id, seq, idx, source, host, tool_name, args, ts, project,
folder, origin, epoch, user_id`. `args` is truncated at 20,000 chars. **There is no
result column** — what a tool *returned* is not stored, and adapters truncate any preview
of it to 300–500 chars inside `messages.text`.

**`sessions`** — one metadata row per session: `name` (first user prompt, 120 chars),
`source`, `host`, `project`, `folder`, `message_count`, timestamps, `extra`. Deliberately
**not** epoch-keyed: latest write wins.

`memhouse sessions-query` prints a self-contained per-session rollup (it carries its own
`FINAL`) — prefer it over hand-joining.

---

## The three things that bite

### 1. Epochs — a plain `SELECT` over-counts

The shipper never overwrites a diverging parse. When a re-parse comes back shorter, or
any overlapping turn hashes differently — which is what a **compaction** does to a long
session — it writes the new parse under `epoch + 1` and keeps the old rows. So the same
session can be present several times over.

Reads must resolve to the current epoch. **Every counting or aggregating query needs
this**, and the physical table name is the *raw* one, so nothing applies it for you:

```sql
WHERE origin != 'ship'
   OR (session_id, user_id, epoch) IN (
        SELECT session_id, user_id, max(epoch) FROM messages
        WHERE origin = 'ship' GROUP BY session_id, user_id)
```

Measured on a real house: omitting it over-counted by **34%**. Drop it deliberately only
when the question is about what a session said *before* it was compacted — superseded
epochs are the one place that content still exists.

### 2. Join on `(session_id, user_id)`, never `session_id` alone

Two housemates can collide on an adapter-local session id. Every join, every `GROUP BY`
that identifies a session, takes both columns.

### 3. Escape before splicing, and lowercase the needle

Search terms, session ids and user ids are arbitrary text going into single-quoted
literals. Escape backslashes then single quotes (`\` → `\\`, `'` → `\'`) in **every**
value. `O'Reilly` otherwise breaks the query, and crafted text could reshape it.

The FTS columns are `lower(text)`, so lowercase what you look for:

```sql
WHERE text_ngram LIKE '%needle%'     -- substring, any length
WHERE hasToken(text_word, 'needle')  -- whole word, faster on common terms
```

---

## Known gaps — say these out loud rather than reporting a wrong number

- **Cost is derived**, from `model` + tokens. Several adapters ship **no tokens at all**
  (`kiro`, `vscode`, `zed`, and `cursor` on one of its two storage paths), so their cost
  reads `$0` — which is *unknown*, not free. `memhouse doctor` names them.
- **Per-message timestamps are interpolated** for most adapters — only the session bounds
  are real. Hour-of-day and "peak time" charts inherit that.
- **`text` stops at 50,000 chars**, tool `args` at 20,000. A missing tail is truncation,
  not absence.
- **Tool *results* are not stored at all.** If the question is "what did that command
  print", the house cannot answer it.
