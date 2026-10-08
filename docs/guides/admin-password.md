# Admin password

A few commands need the ClickHouse server's administrator:

- `install --admin-user …`, which creates a member;
- `invite`;
- `passwd --member …`;
- `members`;
- `convert`.

Shipping, searching and sharing never need it.

**The admin password owns the whole server.** Keep it out of three places:

- **the command line**, where `ps` shows it to every user on the machine while the command
  runs, and shell history keeps it afterwards;
- **an agent's conversation**, because memhouse ships that conversation into the house,
  and the archive is insert-only;
- **disk**, unless you chose that: `--keep-admin`, or `deploy --local`.

## Where memhouse takes it from

In order, first answer wins:

| # | source | use it when |
|---|---|---|
| 1 | `--admin-password-file <file>` | a file you control, mode 600. One trailing newline is dropped |
| 1 | `--admin-password-file -` | piping it in: `printf '%s' "$P" \| memhouse … --admin-password-file -` |
| 2 | `--admin-password <value>` | **deprecated**: works in 0.18.x with a warning, **removed in 0.19.0** |
| 3 | `MEMHOUSE_ADMIN_PASSWORD` | a secret manager lends it to one command (below) |
| 4 | the credential this install keeps | only when it belongs to the same admin user |
| 5 | a prompt | when there is a terminal; input is hidden, and pasting works |

The two forms of `--admin-password-file` are one option, and it cannot be combined with
`--admin-password`. With no source and no terminal, the command stops and prints these
options. It never hangs, and it never guesses.

## With a secret manager

The best form: the value exists only in the one command's environment.

```bash
with-secret MEMHOUSE_ADMIN_PASSWORD=keychain:pilot/house-admin -- \
  memhouse invite alice --url https://house.example.com --admin-user default

# 1Password
op run --env-file=<(echo 'MEMHOUSE_ADMIN_PASSWORD=op://Infra/house-admin/password') -- \
  memhouse members --admin-user default
```

In CI, put it in the job's secret store and expose it as `MEMHOUSE_ADMIN_PASSWORD` for
that step only.

## Typing it once, in a terminal

```bash
memhouse invite alice --url https://house.example.com --admin-user default
# prompts for the admin password; what you type or paste is not shown
```

Or, to reuse it for a few commands in one shell without it reaching history:

```bash
read -rs MEMHOUSE_ADMIN_PASSWORD && export MEMHOUSE_ADMIN_PASSWORD
memhouse members --admin-user default
unset MEMHOUSE_ADMIN_PASSWORD
```

## Keeping it on this machine

`install --admin-user … --keep-admin` writes the admin credential into
`~/.memhouse/env`, so later `invite` and `members` need no flags. `deploy --local` does
the same, because a local house's admin is yours. Otherwise memhouse does not save it.

Even when it is saved, the daemons never carry it: service units and the started
shipper and dashboard have `MEMHOUSE_ADMIN_*` removed from their environment.

To stop keeping it, delete the `MEMHOUSE_ADMIN_USER` and `MEMHOUSE_ADMIN_PASSWORD` lines
from the env file.

## What `whoami --admin` tells you

```bash
memhouse whoami --admin --json
```

This reports what the admin credential (`MEMHOUSE_ADMIN_*`, or the kept one) may
actually do on the server, for example `canProvision`. It never prints the password. Use
it before a scripted run, rather than guessing from a grant string.

## If a password reached a transcript

Treat it as burned. Rotate it on the server (`ALTER USER … IDENTIFIED BY …`, as the
admin) and update every place that legitimately holds it. Deleting the transcript does
not help: the house is insert-only, and it may already have shipped.
