# memhouse examples

Four working setups, smallest first. Each folder has a README and a script you can run as
it is. They all ship **made-up sessions** (from [`fixtures/`](fixtures/)) rather than
yours, and each installs into a memhouse home of its own, so an install you already have
is never touched.

| # | Example | Who it is for | Needs |
|---|---|---|---|
| 01 | [One machine](01-local-one-machine/) | one person, a house in a local container | Node 24, Docker or Podman |
| 02 | [An existing ClickHouse](02-existing-clickhouse/) | you already run ClickHouse, or use ClickHouse Cloud | Node 24, an admin account on it |
| 03 | [A team house](03-team-house/) | an admin, three members, a full share and a scoped one | Node 24, a throwaway ClickHouse and its admin |
| 04 | [Self-hosted for a team](04-self-hosted-team/) | ClickHouse behind TLS, nightly backups, members on other machines | a Linux server with Docker, a DNS name |

To do any of this for real, with your own sessions, skip the script and follow the
README's "For real" section: it is the same commands without the fixture flags.

## Running them

```bash
npm install -g memhouse          # or set MEMHOUSE_BIN to a checkout: "node /path/to/bin/memhouse.js"
cd examples/01-local-one-machine
./run.sh
```

Admin passwords are never typed on a command line. The scripts read them from
`MEMHOUSE_ADMIN_PASSWORD`, which you lend to one command from wherever you keep secrets:

```bash
with-secret MEMHOUSE_ADMIN_PASSWORD=keychain:clickhouse-admin -- ./run.sh
```

Any tool that sets an environment variable for one command does the same job: 1Password's
`op run`, or a `read -rs MEMHOUSE_ADMIN_PASSWORD && export MEMHOUSE_ADMIN_PASSWORD` in the
same shell, which keeps it off the screen and out of shell history.

## How they were tested

Last run on 2026-10-08, memhouse 0.18.9 (main `ccdcfb8`), against ClickHouse 26.7.1.1315,
the version memhouse's own production house runs: 01 on a disposable Linux VM with Docker,
02 and 03 against a disposable ClickHouse, 04 as the full compose stack. The output each
README quotes is from that run.
