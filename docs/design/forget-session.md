# Design: `memhouse forget <session>`

**Status:** proposal; nothing is implemented.
**Origin:** O's sandbox rehearsal 2a, finding 5. memhouse has no per-session delete; forgetting was tested through the member's own `DELETE`.
**Scope:** what forgetting removes, how it stays forgotten, what it needs from the grant, and how it is tested. Any live-house deletion while this is built is out of scope; tests run in a lab on arf.

## Why a command, and why it is hard

`reset` clears the shipper's rows and re-ships everything, which is the opposite of forgetting. A user who pasted a secret into a session, or who wants one conversation gone, has only raw SQL today.

Three properties of the house make "delete the rows" insufficient:

1. **The source is still on disk.** The shipper re-ships any session whose transcript it can read. Delete the rows and the next pass, on this machine or on another machine of the same member, puts them back.
2. **The house keeps every parse.** A session can exist under several `epoch`s and both `origin`s (`ship`, `import`). Forgetting means all of them.
3. **Derived copies exist.** `<member>_session_stats` (which holds the first prompt), `_session_model_stats` and `_session_tool_stats` keep generations for a day. Granted readers may also have read the rows already, and nothing can recall that.

## The command

```
memhouse forget <session-id> [--dry-run] [--yes]
memhouse forget --list
memhouse unforget <session-id>
```

- **Default is a dry run with counts.** It lists rows per room, epochs, origins, hosts and the date span, then asks. `--yes` skips the question. The confirmation names the session and the counts, following the `/mem:admin` rule for destructive work: look, name the collateral, get a yes for that object.
- **It only touches the caller's own rooms** (`mem.<member>_*`, `user_id = currentUser()`). A housemate's session is never theirs to forget.
- **`--list`** shows the tombstones: session, when, from which host.
- **`unforget`** removes a tombstone. The next pass re-ships the session if its transcript is still on some machine's disk.

## What it does, in order

1. **Write a tombstone first.** `INSERT INTO <member>_meta (key, value, updated_by, host) VALUES ('forget:<session_id>', '<iso-date>', …)`. It needs only `INSERT`, and it is what stops re-shipping (below). If a later step fails, the session stays forgotten-pending rather than half-deleted and re-shipped.
2. **Delete the rows**, all epochs and all origins:
   ```sql
   DELETE FROM <member>_messages   WHERE session_id = {sid} AND user_id = currentUser();
   DELETE FROM <member>_tool_calls WHERE session_id = {sid} AND user_id = currentUser();
   DELETE FROM <member>_sessions   WHERE session_id = {sid} AND user_id = currentUser();
   DELETE FROM <member>_session_stats       WHERE session_id = {sid};
   DELETE FROM <member>_session_model_stats WHERE session_id = {sid};
   DELETE FROM <member>_session_tool_stats  WHERE session_id = {sid};
   ```
   These are lightweight deletes: rows are masked at once and physically removed at merge. `FINAL` reads honour them.
3. **Verify.** Re-count each room for the session; anything above zero is reported, never silently accepted.
4. **Record it** in `<member>_events`: `kind = 'forget'`, `id = <session_id>`, the per-room counts before and after, actor and host. Counts only, no content, because the event must not re-store what was forgotten.

## Staying forgotten: the shipper's side

- **Tombstones are read once per pass**, from `<member>_meta` keys `forget:%`, the same way `loadExisting` already reads the sessions room. A tombstoned session is skipped before parsing: nothing is sent, and the pass log counts it ("2 forgotten").
- **Every machine of the member honours it**, because the tombstone lives in the house, not on one disk. That is why it is written first.
- **Older shippers do not know tombstones.** A 0.18.x machine would re-ship the session. `forget` therefore reads the fleet (as `status` does) and refuses while any writer for this member is below the first version that honours tombstones. `--force` overrides, with that machine named in the warning.
- **The transcript on disk is not touched.** memhouse never deletes an editor's files. The command says where the file is, so the user can delete it. Until they do, the tombstone is what keeps it out of the house.

## The grant this needs

- **The standard member grant already covers it.** It includes `ALTER` (which covers `ALTER DELETE`, the privilege a lightweight `DELETE` checks) on `mem.<member>_*`, so a member forgets in their own rooms with nothing new granted.
- **zeo's `polat` is the exception.** `ALTER DELETE, ALTER UPDATE` were revoked from `polat` on 2026-09-22 so that `reset` cannot run there. On such an account `forget` writes the tombstone, which needs only `INSERT`. The tombstone alone stops re-shipping, and readers that filter on it see the session gone. The command then prints the one statement an operator runs, or, once it exists, files the deletion with the memhouse agency (see the agency design item), and reports the state honestly: "forgotten from future ships; rows remain until the operator deletes them".
- **Readers between tombstone and delete:** the dashboard and the skills should filter tombstoned sessions, the way they already filter superseded epochs. Without that filter, a tombstone-only forget is invisible to readers until the delete lands.
- **Granted readers** lose access to the rows when they are deleted. What they read before cannot be recalled; the confirmation says so when the member has active shares.

## What it deliberately does not do

- **Delete the transcript file.** The editor owns it.
- **Forget a housemate's session, or forget by project or date range.** Those are bulk deletes and need their own design, and probably the agency.
- **Promise erasure from backups or exports.** It does promise that the house no longer serves the session, and that no memhouse shipper puts it back.

## Tests (in a lab on arf, never a live house)

- **The happy path, per room:**
  - a session with 2 epochs, both origins and subagent rows is forgotten;
  - every room, including all 3 stat tables, counts 0;
  - the event row has counts and no text.
- **It stays forgotten:**
  - the next `ship`, on the same machine and on a second scratch home acting as another machine of the member, sends nothing for it;
  - `unforget` lets the next pass bring it back.
- **The fleet gate:** a writer below the tombstone-aware version makes `forget` refuse.
- **The tombstone-only path:** a member without `ALTER DELETE` gets the tombstone; ships skip the session; the output says the rows remain and prints the operator statement.
- **Isolation:**
  - `forget` with another member's session id deletes nothing;
  - a scoped grantee cannot read the tombstone keys (meta is not granted to scoped readers since #13).
