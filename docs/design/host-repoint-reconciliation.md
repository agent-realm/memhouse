# Deferred design — host-repoint reconciliation

Status: **DEFERRED, not built.** Captured 2026-08-20 so it is not forgotten.
Target release when built: ~0.12.0. Nothing in this file ships yet.

## The problem

A shipper is configured against one house (say `test.memhouse.io`, db `mem`) and has
been shipping fine. The pilot then changes the environment (new `MEMHOUSE_URL` /
`MEMHOUSE_DB`) to point at a **different host**. The credential is valid there, but that
host has **no memhouse tables** — nothing was ever created.

memhouse should *notice* it has been shipping somewhere up until now and that the new
target is empty, and handle it deliberately — not scribble the pilot's transcripts onto a
stranger, and not just die on a raw "no such table".

## What happens today (the gap)

- **Plain `ship` never creates tables.** Only `install` / `--ensure-schema` do
  (`memhouse/shipper/ship.js`). Repoint to an empty host → `assertWriterSupported` finds
  no `house_meta`, treats it as a "pre-record house" and waves it through → the INSERT
  into `messages` then fails with *no such table*. A raw error, no story.
- **No local memory of the target.** The only state is server-side `house_meta`
  (schema_version, client_*, `last_ship:<writer>` heartbeat). There is **no `house_id`**
  and **nothing on the client** recording which house the shipper is bound to — so the
  shipper cannot tell "I was writing to A, now I'm pointed at empty B" from "first run".

## Two states to add

**Target (server): a house identity.** Stamp `house_meta['house_id']` = a UUID, written
once at house creation (install / invite / init). Presence of `house_id` = an initialized
house with a stable identity; no tables at all = an empty target. `house_id` is what makes
"same house" vs "different house at the same URL" vs "the house I knew got wiped"
distinguishable — a URL alone cannot.

**Local (client): the shipper's binding.** A small `$MEMHOUSE_HOME/house.json`:

```json
{ "house_id": "…", "url": "…", "db": "…", "first_seen": "…", "last_ship_at": "…" }
```

Written on successful install / first ship. This is the "it was working up until some
point" record.

## Startup reconciliation (local × target)

| local state | target | verdict |
|---|---|---|
| none | empty (no tables) | first run / onboarding — create tables, stamp `house_id`, write local. Proceed. |
| none | initialized (`house_id` present) | joining an existing house (invite) — adopt its `house_id`, write local. Proceed. |
| `house_id A` | `house_id A` | steady state — ship. |
| `house_id A` | **empty (no tables)** | **STOP** — see below. |
| `house_id A` | `house_id B` (different, initialized) | **STOP** — now pointed at a different house; re-baseline deliberately or fix env. |
| `house_id A` | tables exist, no `house_meta`/`house_id` (pre-0.10 legacy) | existing path → `memhouse migrate`. |

## How to continue in the STOP case (was shipping to A, target empty)

The shipper must **not silently create tables** on a target it has no memory of once it
remembers a prior house — it cannot tell "I deliberately moved to a fresh host" from "I
fat-fingered the URL," and scribbling transcripts onto a stranger is the bad outcome. So:
refuse loudly, print what was detected, offer two deliberate gestures.

```
memhouse: was shipping to house A (test.memhouse.io / db 'mem').
The host you're now pointed at has NO memhouse tables.
  - meant to start fresh here?   run: memhouse init-here
  - wrong host?                  fix MEMHOUSE_URL back
Shipping is paused until one of these.
```

`memhouse init-here` (or `install` against the new host): create tables, stamp a **new**
`house_id`, rewrite `house.json`, re-baseline. From then on it ships to the new host
cleanly. Also re-applies the honest-identity pin (`async_insert = 0 CONST currentUser`) —
on a fresh host you may hold INSERT but not the pin, so `user_id` would be empty until set.

## The caveat that matters most — data does not follow the pointer

The shipper ships from **local editor session files**, which editors delete after ~weeks.
A fresh target receives only what is still on disk; the **old house keeps the full
archive.** Repointing = start a new archive, not move the old one.

If the pilot actually wants history on the new host, that is a **house-to-house copy**
(`remoteSecure()` INSERT SELECT, or a new `memhouse migrate --from <old-url> --to
<new-url>`) — a separate, larger operation from repointing the shipper, and its own
follow-up. State this plainly to the pilot, because "it was working up until some point"
sounds like a continuity that a repoint alone will not give.

## Scope when built

1. `house_id` stamp in `house_meta` (create paths + a backfill for existing houses on
   `memhouse migrate`).
2. `$MEMHOUSE_HOME/house.json` written on install / first ship.
3. The reconciliation gate in `ship` (the matrix above), before any INSERT.
4. `memhouse init-here` + the refusal message.
5. (Separate, bigger) the host-to-host data-copy command.
