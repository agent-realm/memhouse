# How memory is stored

## A house, rooms, and members

- **A house is a ClickHouse database,** normally `mem`.
- **A member is a ClickHouse user** who ships into it.
- **Each member's rooms are tables named for them:**

| room | holds |
|---|---|
| `<member>_sessions` | one row per session: editor, project, folder, branch, timestamps, title |
| `<member>_messages` | every turn: role, text, model, tokens, timestamp, position |
| `<member>_tool_calls` | every tool call: name, arguments, which message made it |
| `<member>_session_stats`, `_session_model_stats`, `_session_tool_stats` | precomputed rollups for the dashboard, refreshed after each pass |
| `<member>_meta` | memhouse's own records: schema version, writers, shares |
| `<member>_events` | an append-only log: migrations, version changes |

**A member holds one grant: `ON mem.<member>_*`.** That covers their own rooms, present and
future, and nothing else in the database. Nobody is granted the database itself:
`ALL ON mem.*` would also reach rooms created later, which is how two people in one
database once leaked into each other. A member can read their isolation back with
`SHOW GRANTS`.

| | rooms | each member holds |
|---|---|---|
| alone on a laptop | `mem.polat_*` | one grant on `mem.polat_*` |
| a team on one server | `mem.polat_*`, `mem.alice_*`, … | one grant each, on their own |

Reading across members is a `UNION ALL` over the rooms you hold: your own, and any shared
with you. Naming a room you were not granted is an error, never a silent omission.

## Every row says where it came from

- **`user_id`** is stamped by the server: `MATERIALIZED currentUser()`. Async inserts are
  pinned off for members, so the stamp cannot be skipped. `WHERE user_id = 'alice'` is one
  person.
- **`host`** is the machine. Each install mints a random fingerprint once and keeps it in
  `$MEMHOUSE_HOME/host.json`, and every row carries `<hostname>-<8 hex>`. It is random,
  not derived from the machine:
  - a derived id would merge two laptops that both answer to `MacBook-Pro`;
  - a derived id would split one machine in two when it is renamed.

  `memhouse status` shows this machine's id. `memhouse doctor` names every host in your
  rooms.
- **`origin`** says who wrote the row. The shipper writes `ship`; an import writes its own
  value.

## The house never destroys what it cannot rebuild

**The shipper is insert-only.** It runs no `DELETE`, no `TRUNCATE`, and no mutation of
any kind, so no privilege it holds can lose you a row.

That has a cost. ReplacingMergeTree deduplicates but does not diff: a re-parse that yields
*fewer* messages leaves the old, higher-positioned rows in place. A shorter re-parse has
three possible causes:

- an adapter bug was fixed, and the extra rows were junk;
- Claude Code **compacted** the transcript;
- the editor's retention window removed it.

In the last two cases the house holds the only surviving copy. So rows carry an `epoch`,
which says which parse of the session they belong to:

- **Nothing changed**, or the session just grew: the same epoch. Rows deduplicate exactly,
  and no extra storage is used.
- **Shorter, or rewritten at a position the house already holds:** the new parse goes to
  `epoch + 1`. The old parse stays complete and readable.

Reads show one parse per session, the newest, so counts, tokens and cost are not
inflated. The skills, the dashboard and `memhouse search` all filter this way; hand-written
queries should too ([the clause](search-and-resume.md#writing-your-own-queries)).

**Imported history is protected the same way.** `origin` is in the sorting key of
`messages` and `tool_calls`, so a shipped row can never collapse an imported one. Anything
imported from an older house, another product, or a machine that no longer exists survives
every re-ship. `sessions` is the deliberate exception: it holds one row per session, with
no `origin` or `epoch` in its key. A session's metadata has a single current version, and
a second row would make every rollup count its messages twice.

The shipper checks the rooms' sorting keys before it writes, and refuses if they are
wrong. See [Update](update.md#when-the-house-itself-must-change).

## What is not in the house

- Nothing is embedded, summarised or rewritten. Text is stored as the editor wrote it,
  truncated at 50,000 characters per message and 20,000 per tool argument.
- No LLM runs anywhere in memhouse's write or read path. The skills are read by your agent,
  which does the reading and reasoning.
- The local transcript files stay where the editor put them. memhouse reads them and never
  modifies them.
