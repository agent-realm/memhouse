# Troubleshooting

Start with the two diagnostics. Both are read-only.

```bash
memhouse doctor      # the whole pipeline, one line per check
memhouse discover    # what each editor adapter sees on this machine
```

## An editor ships nothing

`discover` lists every adapter. Each one is in one of three states:

- it has sessions, with a count;
- it has none, because the editor is not used on this machine;
- it was **skipped**, with the reason.

A skipped adapter and an editor you do not have both contribute zero sessions, so
memhouse always says which one it is. Common causes, one store at a time:

- **A SQLite store locked by the running editor:** `state.vscdb` for Cursor and VS Code.
  The next pass retries.
- **A store the editor moved or changed** in a new release.
- **A scope that excludes it:** `MEMHOUSE_EDITORS` or a `MEMHOUSE_<EDITOR>_ROOTS` in the
  env file. See [Configuration](configuration.md#which-sessions-ship).

SQLite comes from Node itself (`node:sqlite`), so there is no native module to rebuild.

## Status says the shipper runs, but nothing new arrives

`memhouse status` reads the shipper's last pass from its log, and shows a failing pass
as a failure.

- **`Authentication failed`:** the password in `~/.memhouse/env` is no longer the
  member's. This happens after a `passwd` on another machine, or a reset by the admin. Put
  the current password into `MEMHOUSE_PASSWORD` in `~/.memhouse/env` (or run
  `memhouse setup`, which asks), then restart the shipper.
- **A pass that keeps withholding a session:** an adapter returned nothing for a session
  the house already holds. The shipper refuses to replace a transcript with an empty one,
  and says so on every pass, until the store is readable again.
- **Nothing to ship:** sessions are only shipped once the editor has written them.

## Daemons don't survive a reboot

`memhouse start` uses pidfiles. Its daemons outlive the shell but not a restart. Use
`memhouse service install` ([Daemons](daemons.md)). On Linux, also enable lingering, or
user services stop at logout. A rootless podman house from `deploy --local` has the same
exposure, and `deploy` prints the fix.

## The dashboard is empty, or stale

- **It reads the house, not the machine.** Check `memhouse status` for the connection
  first.
- **It reads precomputed stats,** refreshed at the end of each pass that shipped
  something. On a house where nothing has shipped for a day, the stats age out, and a
  running dashboard keeps reading them. Restart it (`memhouse stop && memhouse start`). It
  then reads the rooms directly, until the next pass that ships refreshes the stats.
  A fix is planned.
- **After an upgrade it shows the old version:** restart it (`memhouse update` does this).

## `EACCES` during `npm install -g`

See [Install](install.md#eacces-on-install). `sudo` is right only when the npm prefix is
owned by root.

## `refused`, `ACCESS_DENIED`, `Not enough privileges`

- For a member, these are expected outside `mem.<you>_*` and the rooms shared with you.
  `memhouse whoami` shows what your credential may do.
- For `invite`, `members` or `convert`: you need the admin credential. See
  [Admin credentials](admin-credentials.md).
- A room that should be yours but is refused usually means the house is older than this
  version. Run `memhouse doctor`, then `memhouse migrate` if it says so.

## Still stuck

Run `memhouse doctor` and `memhouse status --json`, and open an issue with both outputs.
Check them before posting, and remove anything private, such as a host name.
