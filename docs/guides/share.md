# Share and revoke

A share lets another member of the same server read your rooms. It is a ClickHouse
`GRANT SELECT`, so it is read-only, and you can withdraw it. Run these on a machine
installed as yourself. Each command acts on your own rooms only.

```bash
memhouse share bob                          # full: everything in mem.<you>_*
memhouse share bob --only project=billing   # scoped: three rooms, filtered
memhouse share --list                       # what memhouse has recorded
memhouse share bob --revoke                 # take it back
```

## Full or scoped

| | full (`share bob`) | scoped (`share bob --only …`) |
|---|---|---|
| grant | `SELECT ON mem.<you>_*` | `SELECT` on `<you>_sessions`, `<you>_messages`, `<you>_tool_calls` |
| rows | all | those matching the scope, through row policies |
| stats tables (`<you>_session_stats`, model and tool stats) | readable: first prompts, folders, projects and tokens of every session | not granted |
| `<you>_meta`, `<you>_events` | readable, including your other share records | not granted |
| rooms created later | readable | not granted |

**A full share is for someone you would hand your laptop to.** It reaches every table in
your pattern, including ones memhouse adds in a later release. The command says so when
you run it.

## Scopes

`--only key=value[,key=value…]`. All the keys must hold (AND):

| key | filters on |
|---|---|
| `project=` | the project name |
| `folder=` | the working directory |
| `session=` | one session id |
| `host=` | one machine (its fingerprint, as `status` shows it) |
| `source=` | one editor: `claude`, `codex`, `cursor`, … |
| `since=` / `until=` | a date range: message time, or session creation time for `sessions` |

An empty scope (`--only ""`, or `--only "$SCOPE"` with the variable unset) is refused.
It never falls back to a full share.

## How the server must be configured

Row policies in ClickHouse have one sharp edge. On some server configurations, the first
policy on a table hides every row from readers who have no policy of their own: you, and
your full-share grantees. Before it creates the first policy, `share` measures how this
server behaves, and refuses if a policy would blind you. The fix is server configuration
(`users_without_row_policies_can_read_rows`), and it is the administrator's to make.

## Changing a share

- **Scoped to full:** `memhouse share bob`.
- **Full to scoped:** `memhouse share bob --only …`. The wildcard grant is withdrawn
  first, so a failure part-way leaves bob with less access, never more.
- **One scope to another:** run `--only` again with the new scope. It replaces the
  policies.

**Scoped shares made before 0.18.10** granted the whole pattern while filtering only three
rooms. Re-run `memhouse share <user> --only <scope>` once for each, and it is narrowed to
the three rooms.

## Revoking

`--revoke` withdraws the grants (the wildcard and the three rooms), then drops the row
policies. If the server refuses a step, the policies are kept unless every grant is
confirmed gone, so a failed revoke never leaves an unfiltered share behind.

A revoke cannot recall what was already read.

## What `--list` shows

`share --list` reads memhouse's own record, the `share:` keys in `<you>_meta`. A grant
someone made by hand in SQL does not appear there. A member cannot read `system.grants`;
an administrator can, with `SHOW GRANTS FOR <user>`.

## Reading what was shared with you

Shared rooms sit in the same database as yours, under the other member's name, for
example `mem.alice_messages`. Query them with `/mem:sql` or any ClickHouse client, joining
on `(session_id, user_id)` as you would on your own rooms. A table you were not granted is
refused, and a scope you are under returns only its rows.
