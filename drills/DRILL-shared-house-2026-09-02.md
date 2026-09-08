# Drill record — the shared house, 2026-09-02

Plan: [`DRILLBOOK-shared-house-2026-09-02.md`](DRILLBOOK-shared-house-2026-09-02.md).
Version: `memhouse 0.17.0` from `claude/table-prefix`, installed from a packed tarball on
`testbed` (no checkout on the machine). House: `drill` / `drillops` on the lab at
`10.10.10.30:18300`.

Seats staffed: **operator** and **arriver**. The grantee seat was not staffed separately —
the arriver's third situation covered the sharing side, and the grant it produced was
verified from the grantee's credential directly.

**Two conditions were not met, and both weaken the result.** Only one agent kind was
available, so the two seats differ by model rather than by kind — `DRILLS.md` asks for two
kinds because "a door only `claude` can open is a door with a problem", and that is not
tested here. And the principal seat was played by the same party that wrote the plan and
judged the findings.

---

## What it found

Six defects, two of them serious. Both serious ones were in code paths the matrices cover
heavily — and neither could have been caught by a matrix, because in both cases the product
did exactly what its code says and told the operator something false about it.

### 1. `share --only` handed over everything it was asked to withhold

The arriver was asked to open **one project** to a colleague. It ran
`memhouse share ege --only project=santiment`. The command granted `SELECT` on every room,
then failed to build the row-policy filters, and reported *"PARTIALLY APPLIED — a share
filtered on some rooms and not others leaks."*

`ege` could read **every project**. Reproduced exactly:

```
alice: memhouse share bob --only project=alpha
bob:   SELECT project, text FROM mem.alice_messages
       alpha   SECRET alpha
       beta    SECRET beta
```

Two causes, both fixed:

- **The grant came before the filters.** Now the filters are built first, and a failure
  drops whatever it built and grants nothing.
- **The prefixed layout never granted the row-policy rights.** `ALL ON db.*` carries
  `CREATE ROW POLICY` in a house of your own; the explicit per-table list did not, so in a
  shared house the scoping step could not succeed *at all* — the failure was certain, not
  occasional. Verified those privileges are grantable at table scope, and added them.

And `share --list` reported *"nobody has been granted a read"* the whole time, because the
bookkeeping write only happens after the step that failed.

### 2. `--print-sql` printed the configuration the live path refuses

The operator previewed with `--print-sql`, diffed it against the real run, and found they
disagree. It ignored `--shared-db` and `--table-prefix` entirely:

```sql
CREATE TABLE IF NOT EXISTS drillops.messages ...     -- unprefixed, shared
GRANT ALL ON drillops.* TO mert WITH GRANT OPTION;
```

That is the two-members-one-database shape `invite` now refuses, with prose asserting *"the
database IS the boundary"*. The help routes non-admins to this path specifically, so the
person least able to audit the result was handed the leak at exit 0.

Fixed, and the matrix now **executes** the printed SQL and asserts the resulting member
isolates identically to the live path. Printing correct-looking SQL and printing SQL that
works are different claims.

### 3–6, smaller

- No supported way for an operator to answer *"who is in this database?"* — this layout
  creates the question and there was no verb for it. Added `memhouse members`.
- `--shared-db` help was spliced through the middle of a sentence, and four lines
  describing `install` sat under `passwd`.
- `invite` printed *"5 room(s) already exist and are not yours to create"* while verifying
  rooms the operator had created seconds earlier. Sent the operator to `system.tables` to
  find out what had broken; nothing had.
- `share --list --json` accepted the flag and printed prose.

## Reported but not acted on

Pre-existing, unrelated to this layout, and left for their own change:

- `memhouse status` says "dashboard: not running" while an orphaned dashboard serves on the
  port — it checks its pidfile, not the port.
- After `install --force`, the shipper daemon authenticated with the pre-rotation password
  until restarted; it had inherited it from the parent environment rather than re-reading
  the config.
- `doctor` exits 1 for a dashboard port conflict while every substantive check is green.
- 152 local sessions vs 147 shipped, unexplained by `stats` or `doctor`.
- No per-subcommand `--help`.

## What the seats said at the end

The arriver, asked what it would tell a colleague, volunteered the sharing bug unprompted —
*"if you try to scope that to one project, it can fail partway through and leave the other
person with full unscoped access to everything before you notice"* — and rated its own
confidence "high on storage, lower on token semantics". It also read its own transcripts
back out of the house and noted the store holds full verbatim text and tool-call arguments,
not summaries.

The operator's closing note: it wanted to read the source exactly once, when `--print-sql`
and the real run disagreed. That disagreement was the finding.
