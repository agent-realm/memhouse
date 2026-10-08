# Tutorial 3: share your memory

Two members of one house: `alice` and `bob`. Each owns their rooms, and neither can read
the other's. In this tutorial, alice lets bob read one project's history, then everything,
then takes it back. Bob reads it from his own agent.

**You need:** two members of the same house. If you have one house of your own, see
[Invite members](../guides/invite.md) to add a second.

## 1. Alice shares one project

On alice's machine:

```bash
memhouse share bob --only project=memhouse
```

What this does:

- grants bob `SELECT` on exactly three of alice's rooms: `alice_sessions`,
  `alice_messages` and `alice_tool_calls`;
- adds row policies so that, in those rooms, bob sees only rows where
  `project = 'memhouse'`.

Bob gets nothing else. Alice's stats tables, `meta` and `events` stay closed to him, as
does any room alice gains later.

Other scopes work the same way:

- `session=…`
- `host=…`
- `source=…` (an editor, as stored: `claude-code`, `codex`, …)
- `folder=…`
- `since=…` and `until=…` (dates)

Before it creates the first policy, `share` checks how the server treats readers that
have no policy of their own: alice, and anyone with a full share. On some server
configurations, a table's first row policy blinds those readers to every row. On such a
server, `share` refuses rather than lock alice out of her own rooms.

## 2. Bob reads it

Bob's credential can now see three of alice's rooms. From any ClickHouse client, or
`/mem:sql` in bob's agent:

```sql
SELECT project, count() FROM mem.alice_messages GROUP BY project
-- one row: memhouse

SELECT count() FROM mem.alice_session_stats
-- refused: bob holds no grant on it
```

A query that strays outside the scope returns nothing, or is refused for the tables bob
was never granted. It never returns more than the scope.

## 3. Alice widens it to everything

```bash
memhouse share bob
```

A **full share** with no `--only`. Bob can now read all of `mem.alice_*`, including the
stats, `meta` (alice's other share records among it) and `events`. The command says so
when it runs. Use a full share for someone you would hand your laptop to.

Going back from full to scoped is the same `--only` command. It takes the wildcard grant
back first, so a failure part-way leaves bob with less access, never more.

## 4. See who can read what

```bash
memhouse share --list
```

This prints memhouse's own record of the shares: each user, full or scoped, and the scope.
A grant someone made by hand in SQL does not appear.

## 5. Take it back

```bash
memhouse share bob --revoke
```

This withdraws the grants first, then drops the row policies. If the revoke is refused
part-way, the policies stay, so bob never ends up with an unfiltered share.

## What sharing cannot do

- **Recall what was already read.** Bob may have copied rows while he could read them.
- **Write.** A share is read-only. Only alice writes into alice's rooms.
- **End with a password change.** Grants belong to the user, not the password. To cut
  bob off, revoke.

More detail, including what a full share exposes and why scoped shares are table by
table: [Share and revoke](../guides/share.md).
