# Design: `memhouse forget <session>`

**Status:** proposal, revision 2. The direction is approved by AK47 (2026-10-08) with five required changes, all folded in below: the delete/ship race, physical erasure, the production version, tombstone visibility, and the delete predicate. Nothing is implemented.
**Origin:** O's sandbox rehearsal 2a, finding 5. memhouse has no per-session delete; forgetting was tested through the member's own `DELETE`.
**Never on a live house:** every test here runs in a lab on arf, on production's exact ClickHouse version.

## Why a command, and why it is hard

`reset` clears the shipper's rows and re-ships everything, which is the opposite of forgetting. A user who pasted a secret into a session, or who wants one conversation gone, has only raw SQL today.

Four properties of the house make "delete the rows" insufficient:

1. **The source is still on disk.** Delete the rows and the next pass, on this machine or another machine of the same member, puts them back.
2. **A pass already in flight** can insert the session's rows *after* the delete (race; §3).
3. **The house keeps every parse:** several `epoch`s and both `origin`s per session.
4. **Derived copies exist.** `<member>_session_stats` (which holds the first prompt), `_session_model_stats` and `_session_tool_stats` keep generations for a day. Lightweight deletes only *mask* rows until a merge (§4). Granted readers may already have read the rows, and nothing recalls that.

## 1. The command

```
memhouse forget <session-id> [--purge] [--dry-run] [--yes]
memhouse forget --list | --check <session-id>
memhouse unforget <session-id>
```

- **Default is a dry run with counts:** rows per room and per stats table, broken down by `epoch`, `origin`, `user_id` and `host`, plus the date span. Then it asks. `--yes` skips the question. The confirmation names the session and the counts, per the `/mem:admin` rule for destructive work.
- **It only touches the caller's own rooms** (`mem.<member>_*`). A housemate's session is never theirs to forget.
- **`--purge`** also erases the bytes (§4).
- **`--list`** shows tombstones as hash, date and host. **`--check <id>`** answers whether that session is forgotten.
- **`unforget`** removes the tombstone. The next pass re-ships the session if its transcript is still on some machine's disk.

## 2. What it does, in order

1. **Fleet gate.** Read the member's writers, as `status` does. Refuse while any active writer runs a version that does not honour tombstones, naming the machine. `--force` overrides and repeats the warning.
2. **Tombstone.** `INSERT INTO <member>_meta (key, value, …) VALUES ('forget:<h>', '<iso-time>|<host>', …)`, where `h = sha256('memhouse/forget/v1' || member || session_id)` (§5). This needs only `INSERT`. If a later step fails, the session is forgotten-pending, not half-deleted and re-shipped.
3. **Delete**, all epochs and origins (the predicate is §6):
   ```sql
   DELETE FROM <member>_messages            WHERE session_id = {sid};
   DELETE FROM <member>_tool_calls          WHERE session_id = {sid};
   DELETE FROM <member>_sessions            WHERE session_id = {sid};
   DELETE FROM <member>_session_stats       WHERE session_id = {sid};
   DELETE FROM <member>_session_model_stats WHERE session_id = {sid};
   DELETE FROM <member>_session_tool_stats  WHERE session_id = {sid};
   ```
4. **Settle the race (§3):** wait for every writer of the member to finish a pass that *started after the tombstone*, delete again, then verify.
5. **Verify.** Every room and stats table counts zero for the session. Anything else is reported as a failure, never accepted silently.
6. **`--purge` only (§4):** run the mutations, wait for them, and report.
7. **Record it** in `<member>_events`: `kind = 'forget'`, `id = <h>` (the hash, not the session id), counts before and after, whether it was purged, actor and host. No content.

## 3. The race: a pass in flight

A shipper that loaded its state before the tombstone existed can still flush the session's rows after the delete. Two defences, both required:

- **The shipper checks tombstones per batch, not per pass.** Immediately before each flush, it reads `forget:%` keys newer than its last read (one small `SELECT` against `<member>_meta`) and drops any rows whose session hash is tombstoned. This narrows the window to a single in-flight `INSERT`.
- **`forget` re-deletes after the window has closed.** Each shipper already writes `last_ship:<writer>` to meta at the end of a pass. `forget` waits until every active writer of the member reports a `last_ship` later than the tombstone. That bounds the wait by the fleet's longest loop interval, 300 s by default, which is shown while waiting with `--no-wait` to skip it. Then it deletes again and verifies zero. A writer silent beyond twice its interval is reported, not waited on forever.

**The test** runs a pass in flight: a large session, a tiny batch size so the pass is slow, the tombstone written mid-pass. After the settle step, every count is zero, and a further pass ships nothing for the session.

## 4. Physical erasure: `--purge`

A lightweight `DELETE` masks rows at once, and every read honours the mask, `FINAL` included. **The bytes stay on disk until the parts holding them are merged**, and with no partitioning that can take a long time. For the pasted-secret case that is not enough, so:

- **`--purge`** runs `ALTER TABLE <t> DELETE WHERE session_id = {sid}` on each of the six tables. It waits for `system.mutations` (`is_done`, `latest_fail_reason`) and reports per table.
  - **Cost:** a mutation rewrites every data part that contains a matching row. A long-lived session's rows sit in many parts, so on a large house (polat: about 16 M message rows) a purge can rewrite gigabytes and take minutes. The dry run estimates it from `system.parts` (the parts touched, and their bytes).
  - **Why not `OPTIMIZE … FINAL`:** with no `PARTITION BY` it rewrites the whole table, which costs more and helps no more.
- **After the mutation,** the old parts linger until `old_parts_lifetime` (480 s by default) before the server removes them. The command says when the bytes will be gone.
- **Without `--purge`,** the output says so plainly: *"hidden from every read now; the bytes remain on disk until ClickHouse merges these parts. Use `--purge` to rewrite them now."*
- **Backups:** the nightly backups (14 kept) still hold the session until they rotate out, up to 14 days. The command states this; memhouse cannot reach into them.
- **Privilege:** both a lightweight `DELETE` and `ALTER … DELETE` check `ALTER DELETE` on the table (§7).

## 5. Who can see that a session was forgotten

- **Full-share readers can read `<member>_meta` and `_events`.** The share is the `mem.<member>_*` wildcard, and today that means mir and yigido. A table with another name inside the pattern would not hide anything from them.
- **So the tombstone and the event carry a salted hash, never the session id.** The key is `forget:<sha256('memhouse/forget/v1' || member || session_id)>`. The shipper hashes each session id it parses and compares. A reader learns how many sessions were forgotten and when, not which. Someone who already knows an id could hash it and confirm it was forgotten; that is accepted, and documented.
- **Scoped readers** cannot read meta or events at all, since #13.
- **This is documented in the `share` output for full shares:** "a full share also shows how many sessions you forgot, and when".

## 6. The delete predicate: `session_id` alone, inside your own rooms

AK47 asked for `user_id = currentUser()` where the column exists, or a reason not to use it. The reason:

- **Every row in `mem.<member>_*` is the member's own history**, because only the member writes there; shares are `SELECT`. But the stamped `user_id` is not always the member's name. Rows shipped before a member credential existed carry the admin's: polat's rooms hold 104,217 rows stamped `user_id = 'default'`, from 2026-08-20. Rows re-adopted with `invite --adopt` (same person, new credential) carry the old name.
- **A `currentUser()` filter would leave exactly those copies of the session behind.** That is the wrong outcome for a forget.
- **So the predicate is `session_id = {sid}` across the member's own six tables.** The dry run shows the `user_id` breakdown, so the user sees every identity that will be deleted. The stats tables are derived from the member's rooms and carry the same rows. The `(session_id, user_id)` join rule in `HOUSE.md` is for readers crossing several members' rooms, and does not apply inside one member's own tables.

## 7. The grant this needs

- **The standard member grant already covers it.** It includes `ALTER` (which covers `ALTER DELETE`) on `mem.<member>_*`, so a member forgets and purges in their own rooms with nothing new granted.
- **zeo's `polat` is the exception.** `ALTER DELETE, ALTER UPDATE` were revoked on 2026-09-22 so that `reset` cannot run there. On such an account `forget` writes the tombstone (`INSERT` only), which stops re-shipping everywhere. It then reports honestly: "forgotten from future ships; the rows remain until an operator deletes them". It prints the six statements for the operator, or, once it exists, files the request with the memhouse agency (design item D1).
- **Readers should filter tombstoned sessions,** the way they already filter superseded epochs. The dashboard and the skills need that, or a tombstone-only forget stays visible to readers until the delete lands. This is part of the implementation, not a follow-up.

## 8. Version and engine facts to prove in the lab

Production runs **ClickHouse 26.7.1.1315**. The lab uses that exact image tag, never a newer one, and never production itself. To prove:

- **Lightweight `DELETE`** on `ReplacingMergeTree` tables with `text` skip indexes (`idx_text_ngram`, `idx_text_word` on messages): the delete masks the rows, and `FINAL` reads and the text index both stop returning them.
- **Projections:** the rooms and the stats tables have none today. `lightweight_mutation_projection_mode` is checked anyway and its value recorded, so adding a projection later cannot silently break forget.
- **`ALTER … DELETE`** completes on the same tables, after which `system.parts` shows no part still holding the session once `old_parts_lifetime` has passed.
- **The stats tables** (plain MergeTree, 1-day TTL, refreshed by INSERT generations): forget, then a refresh, does not bring the session back, because the refresh reads the rooms, which no longer hold it.

## 9. What it deliberately does not do

- **Delete the transcript file.** The editor owns it. The command says where it is.
- **Forget a housemate's session, or forget in bulk.** Bulk forgetting needs its own design, probably through the agency.
- **Promise erasure from backups or exports.** It promises that the house no longer serves the session, that no current shipper puts it back, and, with `--purge`, that the house's own disk no longer holds it once the old parts are cleaned up.

## 10. Tests (lab on arf, ClickHouse 26.7.1.1315)

1. **Per room:** a session with two epochs, both origins, subagent rows, and rows under two `user_id`s is forgotten. All six tables count zero, and the event row has counts and a hash, no text and no id.
2. **The race (§3):** a pass in flight, tombstoned mid-pass, ends at zero after the settle step, and ships nothing afterwards.
3. **Stays forgotten:** a second scratch home acting as another machine of the member ships nothing for the session. After `unforget`, the session comes back.
4. **`--purge`:** the mutations complete, and after `old_parts_lifetime` no active or outdated part still holds the session.
5. **Fleet gate:** a writer below the tombstone-aware version makes `forget` refuse.
6. **Tombstone-only:** a member without `ALTER DELETE` gets the tombstone, ships skip the session, readers hide it, and the output names the operator step.
7. **Visibility:**
   - a full-share reader sees only the hashes;
   - a scoped reader cannot read the tombstones at all;
   - `forget` given a housemate's session id deletes nothing.
8. **Engine facts (§8)** are recorded with the exact server version in the test output.
