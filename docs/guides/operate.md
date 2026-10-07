# Operate a house

For whoever administers the ClickHouse server behind a house. Each command below takes the
admin credential as described in [Admin credentials](admin-credentials.md). From Claude
Code, `/mem:admin` does the same work and keeps the password out of the conversation.

## Who is here

```bash
memhouse members                 # every member of the house, and what each grant reaches
memhouse members --db other
memhouse whoami --admin          # what the admin credential may actually do
```

Useful read-only SQL, run as the admin:

```sql
-- every house and its size
SELECT database, formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows
FROM system.parts WHERE active GROUP BY database ORDER BY sum(bytes_on_disk) DESC;

-- one member's rooms
SELECT table, formatReadableSize(sum(bytes_on_disk)) AS disk, sum(rows) AS rows
FROM system.parts WHERE active AND database = 'mem' AND table LIKE 'alice\_%'
GROUP BY table;

-- what someone may do
SHOW GRANTS FOR alice;
```

## Adding and removing people

- **Add:** [`memhouse invite`](invite.md).
- **Reset a member's password:** `memhouse passwd --member <name>`. Every machine shipping
  as them stops until its env file has the new password.
- **Remove:** there is no verb yet. `DROP USER <name>` stops every machine shipping as
  that member. Their rooms remain until you drop them as well.

**Before any destructive statement, look first.**

- Count the rows in each room, find who wrote them and when, and from which machines.
- Run every predicate as a `SELECT` before you run it as a `DELETE` or `DROP`.

There are no backups unless you made them, and the transcripts behind a room may already
be gone from the editors that produced them.

## Migrations

When a release needs the rooms rebuilt, the shipper refuses to write until the house is
migrated:

```bash
memhouse migrate --dry-run
memhouse migrate             # copy, atomic swap; the old room is kept as <room>_pre_<suffix>
memhouse migrate-rooms       # the same, rooms only
```

Nothing is deleted. Drop the `_pre_` tables when you are satisfied. See
[Update](update.md#when-the-house-itself-must-change).

## Convert

A house from before 0.18 has a database per member. `memhouse convert` moves it to the one
layout, `mem.<member>_*`:

```bash
memhouse convert --admin-user default --dry-run        # what would move
memhouse convert --admin-user default --print-sql      # the statements, to run yourself
memhouse convert --admin-user default                  # do it
memhouse convert --admin-user default --guides --out ~/Downloads/upgrade
```

`--guides` writes a per-member upgrade guide. Members then run `memhouse update`, and
their shipper adopts the moved rooms itself. Take a server snapshot first.

## Moving a house to another server

`memhouse relocate --to <url>` copies a whole house server-to-server and repoints this
install. **Known gap:** relocate predates the one layout and fails on a one-layout house
before it changes anything. Until it is updated, moving a house is an operator
task with ClickHouse's own tools (`BACKUP`/`RESTORE`, or `INSERT … SELECT FROM remote()`).
Afterwards, point each member at the new URL with `memhouse setup --url …`.

## Backups

memhouse does not back up the house. Use ClickHouse's own `BACKUP DATABASE mem TO …`, to a
disk or an object store, on a schedule, and test a `RESTORE` into a scratch server.
[`examples/04-self-hosted-team`](../../examples/) shows a nightly job.

- **Keep backups as private as the house.** They hold every member's transcripts.
- **Backups outlive deletions.** A row removed from the house remains in every backup
  taken before the removal, until that backup rotates out.

## Server settings that matter

| setting | why |
|---|---|
| async inserts off for members | `user_id` is stamped at insert; memhouse pins `async_insert=0` on each member, and the shipper sets it per insert too |
| `users_without_row_policies_can_read_rows` | scoped shares need it to behave as memhouse expects; `share` measures it and refuses if a policy would blind the owner |
| `old_parts_lifetime` | how long replaced parts stay on disk after merges and mutations (480 s by default) |
| HTTP behind TLS | members connect over HTTP(S); put the server behind TLS before exposing it beyond a LAN |

ClickHouse 25.11 and 26.x are tested in CI.

## A build to test with

`memhouse nightly --out DIR`, run from a checkout, builds an installable, version-stamped
tarball and publishes nothing. Install it on a test machine with
`npm install -g <tarball>`.
