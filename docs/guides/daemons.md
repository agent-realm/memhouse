# Daemons and services

memhouse runs two long-lived processes:

- the **shipper**, which runs an incremental pass every 300 seconds;
- the **dashboard**, on `http://localhost:4640` (`MEMHOUSE_PORT` changes it).

## Until the next reboot

```bash
memhouse start      # both, detached, with pidfiles in $MEMHOUSE_HOME
memhouse stop
memhouse status     # running or not, and whether the last pass succeeded
```

`start` detaches, so the processes outlive the shell, but not a restart.

## Across reboots

```bash
memhouse service install             # systemd --user on Linux, a LaunchAgent on macOS
memhouse service install --interval 600
memhouse service status | stop | start | restart | uninstall
```

`service install` writes a real user service and takes over from any `start` daemons.

- **The unit gets the member credential only.** `MEMHOUSE_ADMIN_*` is dropped before the
  environment is written into the unit, and the shipper and dashboard are started without
  it, even when your shell exported it.
- **On Linux, a `--user` unit stops at logout unless lingering is on.** `service install`
  detects this and prints the `loginctl enable-linger <you>` command.
- **The unit runs the Node binary that installed it.** After a Homebrew or nvm Node
  upgrade, run `memhouse service uninstall`, then `memhouse service install`, so the unit
  points at the new one.

## One pass by hand

```bash
memhouse ship           # one incremental pass, in the foreground
memhouse ship --full    # re-read every session, not just the changed ones
```

A pass is incremental. A session is skipped when the house already holds it at least as
fresh and at least as large. For a session that grew, only the new turns are sent, when
every earlier turn is already in the house unchanged. `--full` rereads everything. It
never deletes anything: see [How memory is stored](storage.md).

## Logs

The daemons log to `$MEMHOUSE_HOME/logs/` (default `~/.memhouse/logs/`): `shipper.log` and
`dashboard.log`. `memhouse status` reads the shipper's last pass from its log, and reports
a failing pass as a failure even while the process is alive.
