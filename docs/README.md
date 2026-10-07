# memhouse documentation

Start with a tutorial if memhouse is new to you. Use a guide when you know what you want
to do. [`examples/`](../examples/README.md) holds runnable setups.

## Tutorials

Each one starts from nothing and ends with something working, in about ten minutes.

| | |
|---|---|
| [1. Your first house](tutorials/01-first-house.md) | one machine: a local ClickHouse, your sessions shipped, the dashboard, search, `/mem:recall` |
| [2. Join a team's house](tutorials/02-join-a-house.md) | someone invited you: install from the invite file, make the password yours, ship |
| [3. Share your memory](tutorials/03-share-your-memory.md) | let a teammate read your house, all of it or one project, and take it back |

## Guides

One common operation each.

| Guide | When you want to |
|---|---|
| [Install and onboard](guides/install.md) | install against a local, existing, or invited house; fix `EACCES` |
| [Configuration](guides/configuration.md) | choose which editors and directories ship; run several instances; follow a channel |
| [Update](guides/update.md) | stay current, and upgrade every machine of a house |
| [Daemons and services](guides/daemons.md) | keep the shipper and dashboard running, across reboots |
| [Invite members](guides/invite.md) | bring a teammate into a house you administer |
| [Share and revoke](guides/share.md) | let someone read your rooms, scoped or whole |
| [Admin credentials](guides/admin-credentials.md) | run an admin command without the password reaching `ps`, history, or a transcript |
| [Search, resume and skills](guides/search-and-resume.md) | find an old session, reopen it, let an agent answer from history |
| [How memory is stored](guides/storage.md) | houses, rooms, epochs, machine identity, what is never deleted |
| [Operate a house](guides/operate.md) | members, migrations, moving a house, backups |
| [Troubleshooting](guides/troubleshooting.md) | an editor ships nothing, daemons stop, a dashboard looks empty |
| [Uninstall](guides/uninstall.md) | stop, forget the house, or remove everything |

## Reference

- `memhouse <command> --help`: every command's own usage. It always prints usage and
  never runs the command.
- [Release notes](releases/): what changed in each version, and what to do about it.
- [`../memhouse/house/HOUSE.md`](../memhouse/house/HOUSE.md): the layout and the schema,
  column by column.
- [`../memhouse/DESIGN.md`](../memhouse/DESIGN.md): the design, and why it is shaped this
  way.
- [`../SECURITY.md`](../SECURITY.md): what holds, and what does not.
- [`design/`](design/): designs captured before they are built.
