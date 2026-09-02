# Security model — stated plainly

memhouse ships your coding-agent transcripts to a ClickHouse **you choose** — a container
on your laptop, a box you run, your company's cluster, or ClickHouse Cloud. memhouse runs
no service of its own: no memhouse cloud to sign up for, no telemetry, no phone-home. The
credential is yours and the data is in your account, wherever you decided that is. That
makes the security model short, and worth stating without varnish.

## What holds

- **A member reaches their own rooms and nothing else.** In a house of their own that is
  `ALL` on one database; in a shared house it is per-table grants on their own rooms, and
  ungranted rooms are not merely unreadable but absent from `SHOW TABLES`. Two houses on
  one server cannot read each other. Reserved databases (`system`, `information_schema`)
  are refused as house names everywhere.
- **A database has ONE owner, or per-member rooms — never both.** A member holding
  `ALL ON db.*` beside members holding rooms could read *and* re-grant everyone else's
  transcripts, needing no admin and notifying nobody. `invite` refuses to create that
  shape, `--adopt` does not override it, and bringing a housemate into a house someone
  already owns fences the owner to their own rooms first.
- **A member can only share what is theirs.** Grant option is scoped to their own rooms,
  so `memhouse share` needs no operator and cannot reach a housemate's rows. A scoped
  share (`--only`) builds its row filters BEFORE granting anything, so a scoping failure
  grants nothing rather than leaving the grantee with everything.
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
- **Isolation is grants, and grants are checkable.** A housemate can run `SHOW GRANTS`
  and see exactly what they hold; memhouse does not ask anyone to trust a row policy they
  cannot inspect. What it does NOT defend against is the operator: whoever administers
  the ClickHouse can read every room by definition, and no arrangement inside the server
  changes that. If you should not be readable by the person running the server, you need
  a different server, not a different layout.
- **Members can enumerate each other** on a shared server: a table you may not read
  errors differently (`Code: 497`) from one that does not exist (`Code: 60`). ClickHouse
  behaviour, verified independent of memhouse's grants. It leaks names, never content —
  and in a shared house the names are guessable anyway (`<member>_messages`), while
  `SHOW USERS` is granted to members deliberately so `/mem:house` can list who to share
  with. Treat membership as public and content as private.

## Reporting

The repository is private during beta. Report security issues to the maintainer
directly (ramazanpolat@gmail.com) rather than in a public channel.
