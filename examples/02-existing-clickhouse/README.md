# 02 — an existing ClickHouse

You already run ClickHouse — a server of your own, your company's cluster, or ClickHouse
Cloud — and want memhouse to keep its house there. You hold an account on it that can
create users. This example builds a **member** account with it, installs as that member,
and keeps only the member's credential on disk.

## What it does

1. `memhouse whoami --admin` checks that the admin credential really can create users and
   grant, before anything is changed.
2. `memhouse install --admin-user …` creates the member (default: your login name), grants
   it `mem.<member>_*` and nothing else, creates its rooms, and verifies the install by
   connecting **as the member**. The admin credential is used for this one command and not
   saved (add `--keep-admin` if this machine should be able to invite people later).
3. `memhouse ship --ensure-schema` creates any room or stat table that is missing — safe to
   re-run, and the thing to run after an upgrade that adds one — then `memhouse ship`
   ships two made-up sessions.
4. `memhouse whoami` and `memhouse status` show the credential this machine now keeps and
   what the house holds.

## Needs

- Node.js 24 or newer, and `npm install -g memhouse`
- The ClickHouse HTTP endpoint, e.g. `https://ch.example.com:8443` (ClickHouse Cloud:
  the HTTPS endpoint from the console). memhouse's CI runs on ClickHouse 25.11 and 26.7.
- An account that can create users and databases and grant what it holds. A server's
  first administrator qualifies: the `default` user of a fresh server, or the user the
  Docker image creates with `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`. Step 1 tells you
  whether yours does before anything changes.
- The admin password where a tool can lend it to one command. It never goes on a command
  line: `ps` and shell history would keep it.

## Run

```bash
export MEMHOUSE_URL=https://ch.example.com:8443
export MEMHOUSE_ADMIN_USER=default
with-secret MEMHOUSE_ADMIN_PASSWORD=keychain:clickhouse-admin -- ./run.sh
```

No secret tool? Read it into this shell without echo:

```bash
read -rs MEMHOUSE_ADMIN_PASSWORD && export MEMHOUSE_ADMIN_PASSWORD
./run.sh
unset MEMHOUSE_ADMIN_PASSWORD
```

| Variable | Default | |
|---|---|---|
| `MEMHOUSE_URL` | (required) | the ClickHouse HTTP(S) endpoint |
| `MEMHOUSE_ADMIN_USER` | (required) | the account that creates the member |
| `MEMHOUSE_ADMIN_PASSWORD` | (required) | its password, lent by a secret tool |
| `MEMBER` | your login name | the member to create |
| `MEMHOUSE_BIN` | `memhouse` | the command to run |
| `EXAMPLE_HOME` | `~/.memhouse-example-02` | this example's memhouse home |

The same install without the script, giving the password on stdin instead of the
environment:

```bash
printf '%s' "$PASSWORD" | memhouse install --url "$MEMHOUSE_URL" --admin-user default \
  --member alice --admin-password-file - --yes
```

## What you should see

Trimmed from a run against ClickHouse 26.7.1.1315 with memhouse 0.18.9 (the test endpoint is shown as `ch.example.com`):

```
== 1. whoami --admin: is this credential really an administrator?
  ✓ admin at https://ch.example.com:8443 — administrator
  credential from: MEMHOUSE_ADMIN_* environment
  may create users:    yes

== 2. install: build member 'polat' with the admin credential, then verify as the member
  ✓ created ClickHouse user 'polat'
  ✓ granted 'polat' mem.polat_* — their rooms and nothing else; async_insert pinned
  ✓ verified as 'polat' with the member credential
  ✓ installed
  the admin credential was used for this install and not saved. To invite later:
     with-secret MEMHOUSE_ADMIN_PASSWORD=<reference> -- memhouse invite <name> --url … --admin-user admin

== 3. make sure every room and stat table exists, then ship once
[memhouse] schema ensured (5 statements)
[memhouse] shipped 2 sessions (0 skipped) → 6 msg rows, 2 tool rows in 0.2s

== 4. whoami: the credential this machine keeps, and what it may do
  ✓ polat at https://ch.example.com:8443 — member
  may create users:    no

== 5. status
  ✓ house: 2 sessions, 6 messages
  ✓ fleet: 1 active writer(s)
```

Step 2 generates the member password and writes it only to the home's `env` file (mode
600). From 0.18.10 no command prints it; earlier versions showed it once on this step.

## Teardown

```bash
./run.sh --teardown
```

Deletes the example's home. The member and its rooms stay in the house: dropping them is
an administrator's decision. As the admin:

```sql
DROP USER polat;
-- then each of mem.polat_sessions, _messages, _tool_calls, _meta, _events,
-- _session_stats, _session_model_stats, _session_tool_stats
```

## For real

Leave out the two fixture flags (`--editors claude --claude-roots …`) and the
`EXAMPLE_HOME`, and every editor on the machine ships into the house. Your other machines
join the same rooms by installing with the same member credential (`memhouse install --url
… --user <member> --password …`, or an invite file — see [03](../03-team-house/)).
