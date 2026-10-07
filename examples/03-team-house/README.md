# 03 — a team house

One house, three people. An administrator invites alice, bob and carol; each installs on
their own machine and ships. Then alice shares her memory two ways — everything with bob,
one project with carol — and the script reads with each person's own credential to show
exactly who can see what. Finally she withdraws both shares.

## The model in four lines

- Every member owns `mem.<member>_*`: five rooms (sessions, messages, tool_calls, meta,
  events) and three stat tables. One grant on that pattern is their whole access.
- Housemates cannot read, list, or touch each other's rooms.
- A **full share** (`memhouse share bob`) grants `SELECT ON mem.alice_*`: every room,
  every project, every machine, and anything ever pasted into a session.
- A **scoped share** (`memhouse share carol --only project=alpha`) grants the three
  transcript rooms only, each behind a row policy. The stat tables, meta and events are
  not shared at all, because they carry no per-session filter.

## What it does

1. The admin runs `memhouse invite <name> --url <house>` three times. Each writes
   `<name>.env`: the member's URL, user, password and house. **That file is a password**;
   hand it over the way you would hand over a password.
2. Each member runs `memhouse install --env <name>.env` in their own home. With `--yes`
   the install also rotates the invited password to one only that machine knows, and
   deletes the spent file. Then each ships two made-up sessions (projects `alpha` and
   `beta`).
3. alice: `memhouse share bob`, `memhouse share carol --only project=alpha`,
   `memhouse share --list`.
4. Reads, each with that person's own credential, straight against ClickHouse.
5. alice: `memhouse share bob --revoke`, `memhouse share carol --revoke`; the reads are
   denied again.

At exit the script drops the three users and their rooms (`KEEP=1` keeps them).

## Needs

- Node.js 24 or newer, `npm install -g memhouse`, and `curl`
- A **throwaway** ClickHouse and its administrator — a scratch container, a lab. The script
  refuses to start if users named alice, bob or carol exist, and at exit it drops the ones
  it created. [04](../04-self-hosted-team/) stands one up, or
  a scratch container (the password comes from your environment, not the command line;
  remove it afterwards with `docker rm -f -v memhouse-scratch`):

  ```bash
  CLICKHOUSE_PASSWORD="$MEMHOUSE_ADMIN_PASSWORD" docker run -d --name memhouse-scratch \
    -p 127.0.0.1:8123:8123 -e CLICKHOUSE_USER=admin -e CLICKHOUSE_PASSWORD \
    -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:26.7.1.1315
  ```

## Run

```bash
export MEMHOUSE_URL=https://memhouse.example.com     # what the members will reach
export MEMHOUSE_ADMIN_USER=admin
with-secret MEMHOUSE_ADMIN_PASSWORD=keychain:clickhouse-admin -- ./run.sh
```

A `localhost` URL works too (the script passes `--allow-local`); for real members it is
wrong, because their `localhost` is their own machine.

| Variable | Default | |
|---|---|---|
| `MEMHOUSE_URL` | (required) | the house endpoint the members use |
| `MEMHOUSE_ADMIN_USER` / `MEMHOUSE_ADMIN_PASSWORD` | (required) | the administrator |
| `MEMHOUSE_BIN` | `memhouse` | the command to run |
| `EXAMPLE_DIR` | a new temp dir | where the three homes live |
| `KEEP` | `0` | `1` keeps the members and their rooms |

## What you should see

From a run against ClickHouse 26.7.1.1315, memhouse 0.18.9 (temp paths shortened):

```
== 1. the admin invites three members
  ✓ invite written: …/alice.env
  ✓ invite written: …/bob.env
  ✓ invite written: …/carol.env

== 2. each member installs from their file, on their own machine (here: their own home)
  alice:   ✓ installed
  alice:   ✓ password rotated — this credential is now yours alone
  alice:   ✓ removed the spent invite file …/alice.env
  alice: [memhouse] shipped 2 sessions (0 skipped) → 6 msg rows, 2 tool rows in 0.3s
  (bob and carol the same)

== 3. alice shares: everything with bob, project alpha only with carol
  ✓ 'bob' can now read every session in your rooms (mem.alice_*)
  ✓ 'carol' can read your rooms in 'mem' where project=alpha
  who can read your rooms in 'mem' — memhouse's own record, not ClickHouse's grant table:
    bob              granted 2026-10-07  (all your rooms)
    carol            granted 2026-10-07 scope=project=alpha
      alice_messages project = 'alpha'
      alice_sessions project = 'alpha'
      alice_tool_calls project = 'alpha'

== 4. who reads what — each with their own credential
  alice, her own messages by project           alpha,beta 6
  bob (full share), alice's messages           alpha,beta 6
  carol (alpha only), alice's messages         alpha 3
  bob, alice's session_stats                   2 rows
  carol, alice's session_stats                 denied
  carol, alice's meta                          denied
  carol, bob's messages (never shared)         denied

== 5. alice withdraws both shares
  ✓ revoked 'bob' — SELECT withdrawn and 3 row policies dropped
  ✓ revoked 'carol' — SELECT withdrawn and 3 row policies dropped
  bob, alice's messages                        denied
  carol, alice's messages                      denied
removed alice, bob, carol, their rooms and their homes
```

The revoke line for bob counts the three policy drops memhouse attempts on every revoke;
a full share has no policies, so none existed to drop.

## For real

- **The admin** runs `memhouse invite <name> --url <house URL>` once per person and hands
  each file over a trusted channel (a password manager, `croc`, in person) — not chat or
  e-mail. Add `--admin-user` when the admin credential is not kept on that machine; the
  password comes from `MEMHOUSE_ADMIN_PASSWORD` or `--admin-password-file -`.
- **Each member** runs `memhouse install --env <name>.env` on their laptop, without the
  fixture flags, then `memhouse start` (or `memhouse service install`) to keep shipping.
- **Sharing** is the member's own decision and needs no admin: `memhouse share <user>`,
  `--only project=<p>` (also `session=`, `host=`, `source=`, `folder=`, `since=`,
  `until=`), `--revoke`, `--list`.
- A grantee reads the shared rooms with their own credential: `/mem:recall` and the other
  agent skills, or SQL against `mem.<owner>_messages`.
