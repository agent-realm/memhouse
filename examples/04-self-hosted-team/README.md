# 04 — a self-hosted house for a team

The full deployment: ClickHouse on a server you run, behind TLS, backed up every night,
with members shipping from their own laptops. One compose file holds all of it.

```
 member laptops                         your server (docker compose)
 ─────────────                          ─────────────────────────────────────────────
 memhouse shipper ──https:443──▶ caddy ──http──▶ clickhouse ◀── backup (nightly)
 /mem skills, dashboard            (TLS)         (not published)     │
                                                    │ data volume    ▼ backups volume
```

| Service | Image | Role |
|---|---|---|
| `clickhouse` | `clickhouse/clickhouse-server:26.7.1.1315` | the house. No published port; reachable only through Caddy. |
| `caddy` | `caddy:2.10` | TLS on 443: a Let's Encrypt certificate for your domain, or Caddy's own CA. Port 80 answers the ACME challenge and redirects. |
| `backup` | the ClickHouse image | at `BACKUP_AT` (UTC) writes the house **and its accounts** to the `backups` volume; keeps the newest `BACKUP_KEEP` (14). |

ClickHouse is configured inline (`configs:` in [compose.yml](compose.yml)): the `backups`
disk, and `users_without_row_policies_can_read_rows` set explicitly to `true`, which
memhouse's scoped shares depend on (`memhouse share --only` measures it and refuses when it
is off). The image creates your admin account at first start and removes the passwordless
`default` user.

## Needs

- A Linux server with Docker and Compose v2.23.1 or newer (`docker compose version`)
- A DNS name pointing at it, with ports 80 and 443 reachable from the internet for a Let's
  Encrypt certificate. On a private network, use `MEMHOUSE_TLS=internal` instead (see
  [TLS](#tls)).
- On each member's machine: Node.js 24 and `npm install -g memhouse`

## Set up

```bash
cp .env.example .env && chmod 600 .env
$EDITOR .env          # MEMHOUSE_DOMAIN, MEMHOUSE_TLS, MEMHOUSE_ADMIN_PASSWORD (openssl rand -base64 24)
docker compose up -d
./smoke.sh            # optional: proves the stack end to end, then cleans up after itself
```

`.env` holds the admin password; it is git-ignored and should stay mode 600. Keep a copy
of the password in your secret store: you need it to invite people and to restore.

### TLS

- **Public server** — `MEMHOUSE_TLS=you@example.com`. Caddy gets and renews a Let's Encrypt
  certificate for `MEMHOUSE_DOMAIN`. Members need nothing extra.
- **Private network** — `MEMHOUSE_TLS=internal`. Caddy signs with its own CA. Every client
  must trust it: copy it out once and point Node at it on each member machine.

  ```bash
  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./memhouse-ca.crt
  # on each member machine, in the shell profile or the service environment:
  export NODE_EXTRA_CA_CERTS=/path/to/memhouse-ca.crt
  ```

## Invite members

From any machine with memhouse, with the admin password lent for one command:

```bash
with-secret MEMHOUSE_ADMIN_PASSWORD=keychain:memhouse-admin -- \
  memhouse invite alice --url https://memhouse.example.com --admin-user admin
```

That creates the user `alice`, grants her `mem.alice_*` and nothing else, and writes
`invite-alice.env`. **The file is a password**: hand it over through a password manager or
`croc`, not chat. [03](../03-team-house/) walks through invites and sharing in detail.

## Members: install and keep shipping

On alice's laptop:

```bash
npm install -g memhouse
memhouse install --env invite-alice.env    # offers to rotate the password, then deletes the file
memhouse service install                   # ship at login: systemd user unit or launchd agent
memhouse plugins install claude            # /mem:recall and the other agent skills
```

`memhouse service status` shows the unit; `memhouse status` shows freshness and every
machine writing to her rooms. Without a service, `memhouse start` runs the shipper and the
dashboard as background processes until logout.

## Smoke test

`./smoke.sh` brings the stack up with `.env`, then, through the proxy only: checks the
certificate, that the `default` user is gone, invites a member `smoke`, installs it from
the invite file, ships two made-up sessions, reads them back as the member, backs up and
restores the member's messages, and checks the nightly job. At exit it drops `smoke` and
its rooms (`KEEP=1` keeps them). `SKIP_UP=1` tests a stack that is already running; see
the top of the script.

From a run with `MEMHOUSE_TLS=internal` on a Linux VM with Docker:

```
smoke test against https://localhost:18443
  ok    the proxy answers over TLS (certificate verified)
  ok    the passwordless default user is gone
  ok    admin reaches ClickHouse 26.7.1.1315
  ok    admin invited member 'smoke'
  ok    the member installed from the invite file, over https
  ok    shipped: shipped 2 sessions (0 skipped) → 6 msg rows, 2 tool rows in 0.6s
  ok    the member reads its 6 messages back through the proxy
  ok    the member cannot create tables outside mem.smoke_*
  ok    BACKUP to the backups disk
  ok    RESTORE from it
  ok    the restored copy holds the same 6 rows
  ok    the backup service has written a nightly backup since the server started

12 passed, 0 failed
```

## Backups and restore

Every night the `backup` service runs

```sql
BACKUP DATABASE mem, TABLE system.users, TABLE system.roles, TABLE system.row_policies,
       TABLE system.settings_profiles, TABLE system.quotas
TO Disk('backups', 'mem-YYYY-MM-DD-HH_MM.zip')
```

and deletes all but the newest `BACKUP_KEEP`. The accounts are in the same file on
purpose: users, their password hashes, their grants and the row policies of scoped shares
live outside the database, and a restored house without them is one nobody can log in to.
`docker compose logs backup` shows each run.

**Get the backups off the server.** The `backups` volume sits on the same disk as the data;
copy the files somewhere else on a schedule of your own:

```bash
# The files belong to ClickHouse inside the volume (mode 640); hand the copies to you.
docker run --rm -e OWNER="$(id -u):$(id -g)" -v memhouse-team_backups:/b:ro -v "$PWD":/out \
  alpine sh -c 'cp /b/mem-*.zip /out/ && chown "$OWNER" /out/mem-*.zip'
```

**Restore** onto a fresh stack (same compose file, same `.env`, empty volumes):

```bash
docker compose up -d
docker compose cp mem-2026-10-07-21_17.zip clickhouse:/backups/
# the server reads backups as the clickhouse user; a copied-in file arrives as root
docker compose exec clickhouse chown clickhouse:clickhouse /backups/mem-2026-10-07-21_17.zip
```

then, as the admin:

```sql
RESTORE DATABASE mem, TABLE system.users, TABLE system.roles, TABLE system.row_policies,
        TABLE system.settings_profiles, TABLE system.quotas
FROM Disk('backups', 'mem-2026-10-07-21_17.zip')
```

Members come back with their own passwords and grants, so their machines keep shipping
once the DNS name points at the new server. Restoring accounts fails if a user of the same
name already exists, which is why this is a restore onto a fresh stack. To look inside a
backup without touching the live house, restore just the data under another name:
`RESTORE DATABASE mem AS mem_check FROM Disk('backups', '<file>')`, then
`DROP DATABASE mem_check`.

Tested on ClickHouse 26.7.1.1315: a nightly file copied off the server with the command
above, a fresh stack (`down -v`, `up`), the copy put back and restored — the data came
back, and the member logged in with its original password.

## Upgrading ClickHouse

1. Read the ClickHouse changelog between the two versions. memhouse's CI runs against
   25.11 and 26.7; memhouse adapts its text-index DDL to the server's grammar on its own.
2. Take a backup now: `BACKUP_ON_START=1 docker compose up -d --force-recreate backup`
   writes one immediately (check `docker compose logs backup`), and copy it off the server.
3. Set `CLICKHOUSE_TAG` in `.env` to the new version, then
   `docker compose pull clickhouse backup && docker compose up -d`.
4. Check from a member machine: `memhouse doctor`, `memhouse status`. Or run
   `SKIP_UP=1 ./smoke.sh` with the target variables set.

Do not go back to an older ClickHouse on the same data volume; going back means restoring
a backup onto the older version.

## Teardown

```bash
docker compose down        # stops everything, keeps the data, backups and certificates
docker compose down -v     # ALSO deletes the house, the backups and the certificates
```
