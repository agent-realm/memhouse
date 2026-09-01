# The house — connect, schema, and the three things that bite

Read this before writing any query. Every `/mem:*` skill points here rather than
repeating it, so there is one description of the store and it is either right everywhere
or wrong everywhere.

---

## What this is

A **house** is a ClickHouse **database**. Its **rooms** are tables — `sessions`,
`messages`, `tool_calls` — and the server stamps who wrote every row. No cloud: a house's
grants reach nothing outside it.

What a member owns inside a house depends on how it was set up, and there are two answers:

| | rooms | the member holds |
|---|---|---|
| **a house of their own** | `alice.messages` | `ALL` on the database |
| **rooms in a shared house** | `mem.alice_messages` | those rooms, and nothing else in the database |

The second exists for a ClickHouse where a database per person is not available. Both
isolate; a housemate can never read rooms they were not granted. **`memhouse rooms` says
which you are in and what your tables are actually called** — in a shared house a bare
`FROM messages` names nothing you have, and the `q()` below supplies the prefix for you.

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
  sed -E "s/([[:space:](]|^)(FROM|JOIN)[[:space:]]+(sessions|messages|tool_calls|house_meta|house_events)([[:space:];,)]|\$)/\1\2 ${MEMHOUSE_TABLE_PREFIX:+${MEMHOUSE_TABLE_PREFIX}_}\3\4/g" \
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

**Two layouts, and you may be in either.** Normally a member owns a whole database and
the rooms are plainly named — `alice.messages`. But a house provisioned with
`invite --shared-db` puts everyone in ONE database under their own names —
`mem.alice_messages`, `mem.bob_messages` — and grants each member only their own rooms.
`memhouse rooms` reports which you are in and what your tables are actually called; it
resolves through the same function the shipper writes with, so it cannot drift. A bare
`FROM messages` in a shared house is not a table you have — hence the `sed`.

**Reading someone else's house.** A share is a read-only `GRANT SELECT` on their
database. `SHOW DATABASES` lists what your credential may read; anything that is not
`system`, `information_schema`, `default` or your own `$MEMHOUSE_DB` was shared with you.
To read it, change `database=` in the URL and leave the table names bare. Say whose house
an answer came from.

In a **shared** house a share is narrower still — a `GRANT SELECT` on the individual
rooms, so what you gain is `mem.yigit_messages`, not a database. Name those rooms in full
(`FROM yigit_messages`); the `sed` leaves them alone, since it would otherwise apply your
prefix to someone else's room. `SHOW TABLES FROM mem` lists exactly what you may read.

---

## Schema

**`messages`** — one row per turn.

| column | meaning |
|---|---|
| `session_id` | `<source>:<adapter-local id>`, e.g. `claude-code:6b1f…` |
| `seq` | position in the session, from 0 |
| `source` | editor: `claude-code`, `codex`, `cursor`, … |
| `host` | the machine, `<hostname>-<8 hex>` — random per install, not derived |
| `ts` | when the turn happened (`DateTime64(3,'UTC')`) |
| `role` | `user`, `assistant`, `system` |
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
