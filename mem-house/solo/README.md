# memhouse solo — the single-user tier

One person's memory, with no ClickHouse server and no container.

```bash
npm install -g memhouse --allow-scripts=better-sqlite3,chdb
memhouse deploy --solo
```

That is the whole install. An embedded ClickHouse (chdb) runs behind a small local HTTP
shim that speaks the ClickHouse HTTP interface, so the shipper, the REST server, the
dashboard and the skills all work unchanged — they point at `http://127.0.0.1:8123` and
cannot tell the difference.

## Where this sits among the tiers

| Tier | House | Members | Sharing |
|---|---|---|---|
| **solo** | embedded chdb, no server | exactly one | none |
| **local** | `deploy --local` — stock ClickHouse in docker/podman | one or more | grants |
| **kernel** | an agency house on an ultimagent kernel | many | grants + row policies |

## What solo deliberately cannot do

chdb has **no users, no `GRANT`, no row policies** — that is precisely what separates it
from a ClickHouse server, and it is not a gap to be worked around.

- **No sharing.** There is no second identity to share with.
- **`user_id` is decoration here.** Every row stamps `default`, because `currentUser()`
  is always `default`. It is provenance for the schema's sake, **not** an isolation
  boundary — there is only ever one identity, so nothing is being isolated.
- **The per-member room layout does not apply.** Solo uses the shared-room schema
  (`sessions`, `messages`, `tool_calls`), since rooms-per-member exists to carry grants
  and there are none.

If two people, or two identities, need separating, that is the local or kernel tier.
Do not reach for solo and add users later — the upgrade path is a fresh house.

## Security

Loopback only, and **no authentication at all**. Anything that can reach the port reads
every transcript. That is acceptable only because it is `127.0.0.1` on one person's
machine. Do not expose it, and do not put it behind a reverse proxy without adding auth.

## Verified

On testbed (Linux, node v24.18.0, chdb 3.2.0 = ClickHouse 26.5.1.1):

- the full schema applies — `ReplacingMergeTree`, `JSON`, both text-index layers native
  (chdb is 26.5, so no `allow_experimental_full_text_index` flag needed)
- **161 sessions / 22,413 message rows / 16,197 tool rows** shipped through the shim
- full-text search returns matches; `memhouse stats` works unchanged
- data **survives a shim restart** — the chdb session path is persistent

## How the shim works, and the two things that are easy to get wrong

`@clickhouse/client` sends a plain query as the POST **body**, but an insert as
`?query=INSERT INTO t FORMAT JSONEachRow` with the **rows** as the body. Conflating the
two makes every insert a syntax error against the row JSON. They are concatenated exactly
as a real server reads them off the wire.

The client also sends `?database=X` on **every** request — including the
`CREATE DATABASE X` that brings X into existence. chdb sessions are stateful, so the shim
issues a bare `USE X` once, and only when X already exists. Prefixing `USE X;` onto every
statement fails the bootstrap with `UNKNOWN_DATABASE` before anything can be created.

## Dependency

`chdb` is an **optional** dependency. A normal install neither needs nor builds it; only
this tier does, which is why the install line above adds it to `--allow-scripts`.
