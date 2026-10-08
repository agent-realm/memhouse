# Update

```bash
memhouse update            # upgrade along this install's channel, restart the daemons, check the house
memhouse update --check    # compare versions, change nothing
```

`update` does three things that a bare `npm install -g memhouse@latest` does not:

1. **It restarts the daemons.** A running shipper keeps parsing with the code it booted
   with. One once ran for 1 day 16 hours out of a directory that had since been moved.
2. **It checks whether the house needs a migration** for the new version, and offers to run
   it. `--migrate` runs it without asking.
3. **It stays on your channel** (`MEMHOUSE_CHANNEL`). See
   [Configuration](configuration.md#channels).

Upgraded by hand already? Finish the job without reinstalling:

```bash
npm install -g memhouse@latest
memhouse update --no-install
```

The daemons also notice on their own. Each one compares the installed version with the
version it booted with, and hands over when they differ: under systemd or launchd it
exits so the supervisor restarts it; with nothing supervising, it re-executes itself.
`update` just makes the switch immediate.

## Several machines on one house

Every machine of every member runs its own shipper. Upgrade them all.

- The release notes for each version say whether the order matters and whether mixed
  versions can ship side by side. See [`docs/releases/`](../releases/).
- `memhouse status` lists every machine writing to your rooms, with the version each
  last reported and when it last shipped. A machine that is behind is named there.
- Machines that stopped writing long ago are folded into one line. That is history, not
  a fault. `memhouse status --all` lists them.

## When the house itself must change

Some releases need the rooms rebuilt, for example when a sorting key changes. The shipper
checks the rooms' keys before it writes, and **refuses** to write into a house it does not
match, so an old house cannot be corrupted by a new shipper. To bring the house up to
date:

```bash
memhouse migrate --dry-run   # what would run
memhouse migrate             # copy, atomic swap; nothing is deleted
memhouse doctor              # every line a check mark
```

A migration copies each room, swaps it in atomically, and keeps the old one as
`<room>_pre_<migration>` for you to drop when you are satisfied. The house records the move
in its `events` room, and `doctor` reads it back.

## Upgrading from 0.9.x

0.9.x predates migrations, and `update` runs the **old** version's code (it replaces itself
mid-run), so it cannot prompt. After the upgrade, the first ship refuses (nothing is lost)
and names the one command to run by hand: `memhouse migrate`.

## Upgrading a pre-0.18 house (a database per member)

0.18 moved every member's rooms into one database, as `mem.<member>_*`. An operator moves
an old house once with `memhouse convert`; see [Operate a house](operate.md#convert). After
that, members upgrade with `memhouse update`, and the shipper adopts the moved rooms
itself.
