# Security model — stated plainly

memhouse ships your coding-agent transcripts to a ClickHouse **you point it at**. There
is no memhouse cloud, no telemetry, no phone-home. That makes the security model short,
and worth stating without varnish.

## What holds

- **The database is the boundary.** A member holds `ALL` on their own house and nothing
  anywhere else; two houses on one server cannot read each other. Reserved databases
  (`system`, `information_schema`) are refused as house names everywhere.
- **Attribution cannot be faked by a client.** `user_id` is `MATERIALIZED
  currentUser()` — computed by the server during the insert — and `async_insert = 0
  CONST` is pinned on every member so the stamp cannot be skipped (an async flush
  stores it empty; measured on 25.11).
- **The dashboard binds loopback** (`127.0.0.1`) by default, and `deploy --local`
  binds the ClickHouse container to loopback too.
- **Credentials are never printed.** The skills are under standing instruction not to
  echo the env file, and the API's responses and error bodies were checked for
  credential leakage under the acceptance suite.
- **The tarball is audited in CI** for env files, credentials and host identities.

## What you must know

- **The dashboard has no authentication.** Loopback-only is the protection. If you
  expose `MEMHOUSE_HOST=0.0.0.0`, anyone who can reach the port can read every
  transcript in the house and run read-only SQL. Do not expose it; put a reverse proxy
  with auth in front if you must.
- **`/api/query` is read-only by enforcement, within limits.** Writes and table
  functions (`url()`, `file()`, …) are refused server-side per request; resource use is
  capped per query. It is still full SQL over your own house — treat dashboard access
  as house access.
- **The env file holds the house credential** (`~/.memhouse/env`, mode-restricted).
  `service install` inlines the same credential into the systemd/launchd unit, and says
  so. `uninstall` keeps it by default; `--credentials` or `--full-removal` remove it.
- **Transcripts are shipped as-is.** memhouse does not redact. Whatever your editors
  wrote to disk — including any secret an agent echoed into a session — is what lands
  in the house. The house is as sensitive as your shell history; place it accordingly.
- **Housemates are trusted.** Everyone granted on a house reads (and holds write
  privileges on) the same tables. The isolation mechanism between parties who should
  not see each other is a separate house, not machinery inside one.
- **Members can enumerate each other** on a shared server: a table you may not read
  errors differently from a table that does not exist. This is ClickHouse behaviour,
  verified independent of memhouse's grants. It leaks names, never content.

## Reporting

The repository is private during beta. Report security issues to the maintainer
directly (ramazanpolat@gmail.com) rather than in a public channel.
