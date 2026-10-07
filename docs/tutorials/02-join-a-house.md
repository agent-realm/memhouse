# Tutorial 2: join a team's house

Someone runs a house and invited you. They gave you a file named `invite-<you>.env`. At the
end of this tutorial your sessions ship into your own rooms in their house, under a
password only you know.

**You need:**

- Node 24 or newer;
- the invite file, received over a trusted channel: croc, a password manager, or a USB
  stick. Not chat or email. **The file contains a password.**

## 1. Install memhouse

```bash
npm install -g memhouse
```

On Linux with a distro-packaged Node, prefix with `sudo`. See
[the install guide](../guides/install.md#eacces-on-install).

## 2. Install from the invite

```bash
memhouse install --env invite-<you>.env
```

This reads the house's address, your member name and a starting password from the file.
It then connects, checks that you can write to your rooms, and ships every session on
this machine. Your rooms already exist and are named for you: `mem.<you>_messages`,
`mem.<you>_sessions`, and so on. You hold one grant, on `mem.<you>_*`, and nothing else in
the database.

Then it **offers to change the password** to one only this machine knows. Say yes. The
person who invited you set the starting password, and once you rotate it, theirs stops
working. Then it deletes the invite file, which is spent.

Scripted, with no terminal: `--yes` rotates without asking.

## 3. Check who you are

```bash
memhouse whoami
memhouse status
```

`whoami` names the credential in use and what it may do. You should be a **member**,
not an administrator. `status` shows the connection, your row counts and freshness.

## 4. Keep shipping

```bash
memhouse start                # shipper + dashboard, until the next reboot
memhouse service install      # or: survive reboots (systemd --user / LaunchAgent)
```

Your dashboard is at http://localhost:4640. It reads the house, so it shows your
sessions from every machine you install on, not just this one.

## 5. More machines

Every machine you own ships into the same rooms, and the `host` column tells them apart.
The invite file is spent, so set up the next machine from this one's env file:

1. Copy `~/.memhouse/env` to the new machine over a trusted channel, to any path, say
   `~/mh.env`. It holds your connection and your new password.
2. On the new machine, install from that copy:

   ```bash
   memhouse install --env ~/mh.env
   ```

   This installs and then deletes the copy. It does not offer to rotate: only an invite
   file does, and rotating here would lock out your first machine.

Do not copy `~/.memhouse/host.json`. It is the first machine's identity, and each machine
mints its own.

## 6. Read your teammates' memory

Not yet. Nobody can read your rooms, and you cannot read theirs, until someone runs
`memhouse share`. [Tutorial 3](03-share-your-memory.md) covers it from both sides.

## When something goes wrong

- **`Authentication failed`** right after install: the inviter may have re-issued your
  invite, or you rotated and another machine still has the old password. `memhouse passwd`
  sets a new one; then update the other machines.
- **`invite file … no such file`**: check the path. The file is deleted only after a
  successful install.
- Anything else: `memhouse doctor`, then [Troubleshooting](../guides/troubleshooting.md).
