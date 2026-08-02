# MIGRATION — shared rooms to per-member rooms

Skeleton. Two migrations are in scope and they are different problems.

## A. Existing house, shared rooms to per-member rooms

Today's house has three rooms holding every member's rows, separated by `user_id`.
The move is a fan-out.

```sql
-- per member <m>, per room <r>
INSERT INTO memhouse.<m>_<r> SELECT * FROM memhouse.<r> FINAL WHERE user_id = '<m>';
```

Two things make this less simple than it looks.

**`user_id` is `MATERIALIZED`, so it cannot be inserted.** The destination room
re-stamps it as `currentUser()` — which will be whoever runs the migration, not the
original author. Running the fan-out as the owner would rewrite every row's
provenance to `memhouse_root`.

> **OPEN — this is the blocking question for migration.** Either run each member's
> fan-out under that member's credential, or make `user_id` a plain column with a
> default on the destination rooms, or accept the rewrite and carry the original in
> `extra`. The first preserves truth and needs every member's credential; the second
> weakens the unspoofable-provenance property that the whole identity model rests on.

**`FINAL` matters.** The source rooms are `ReplacingMergeTree`; without `FINAL` the
fan-out copies superseded duplicates.

Afterwards: verify per-member counts against the source, then drop the shared rooms —
not before. Consider keeping them read-only for one cycle.

## B. Schema change once per-member rooms exist

A column added to the room shape must reach N member rooms. **This is progressive, not
lock-step**, which is the useful measured result:

1. `ALTER` the Merge room first — it is the read path.
2. `ALTER` member rooms at any pace.

`Merge` returns the column default for rooms that do not have it yet, so reads never
break mid-migration; they show defaults until each room catches up.

Two traps, both measured:

- **`MATERIALIZE COLUMN` does not fix a Merge read.** The failure is a missing column
  on the *Merge room*, not missing values in the source. `ALTER TABLE all_x MATERIALIZE
  COLUMN c` fails outright — `Table engine Merge doesn't support mutations`.
- **`ADD COLUMN` on the Merge room is the fix**, and must come first.

The same `provision-member-rooms` capability should be the migration hook: idempotent,
re-runnable, and responsible for both the member rooms and the Merge rooms.

## C. Not a migration: a fresh house

New installs start per-member and skip A entirely. Worth keeping the fan-out out of
the common path so it does not become load-bearing code.

## Not yet written

- the fan-out script and its credential story (blocked on the `user_id` question)
- verification queries — per-member row counts, and a spot check that
  `first_prompt`-style aggregates match before and after
- rollback: if the fan-out is wrong, the shared rooms are the backup, so the drop step
  is the point of no return and should be explicit and late
