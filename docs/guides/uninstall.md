# Uninstall

Three tiers. **None of them touches the memory in the house.**

```bash
memhouse uninstall                   # stop everything; KEEP the config and this machine's identity
memhouse uninstall --credentials     # also forget the house and its password
memhouse uninstall --full-removal    # all of ~/.memhouse, identity included
npm uninstall -g memhouse            # then remove the package
```

- **The default is the conservative one.** Stopping the shipper is routine: before an
  upgrade, while debugging, or when a laptop should go quiet for a week. It should not
  also mean "forget which house I use and who this machine is".
- **`--full-removal` asks first.** A later reinstall mints a **new** machine identity, and
  this machine then reads as two machines in your history.
- **Your memory stays.** The rooms in ClickHouse are untouched by every tier. What the
  shipper wrote can be rebuilt from the local session stores with `memhouse ship --full`,
  for as long as the editors keep them.

## Removing the house itself

- **A local house** from `deploy --local`: `memhouse deploy --down` removes the container
  **and its data volume**. That deletes the memory, and there is no undo.
- **A shared server:** an administrator drops your rooms and user. See
  [Operate a house](operate.md).

## Removing the skills

```bash
memhouse plugins remove claude
```

This removes the `/mem:*` skills, and the instance binding, from the Claude Code config
directories they were installed into.
