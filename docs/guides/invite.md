# Invite members

Inviting creates a ClickHouse user and their rooms, and writes one file the invitee
installs from. It needs a credential that can create users, which means the server's
admin.

```bash
memhouse invite alice --url https://house.example.com
#   invite written: invite-alice.env
```

- **`--url` is the address the invitee will reach the house at,** not yours. It cannot be
  loopback: `localhost` on their machine is their machine. Use a LAN address, a hostname
  or a tunnel. `--allow-local` overrides this, for the case where the invitee is on the
  same machine.
- **The rooms are named for them:** `mem.alice_sessions`, `mem.alice_messages`, and so on.
  Alice is granted exactly `mem.alice_*`, nothing else. A different database:
  `--db <name>`.
- **The file is a credential.** It holds the house URL, alice's user name, a generated
  password and the database. Hand it over a channel you trust: croc, a password manager.
  Not chat or email. `--out <path>` writes it somewhere else.
- **Alice installs with `memhouse install --env invite-alice.env`.** It offers to rotate
  the password to one only she knows, which works because she is granted `ALTER USER` on
  herself. Then it deletes the file. Once she rotates, the password you saw stops working.

## Which admin credential

`invite` uses, in order:

1. the admin credential this install keeps. `deploy --local` keeps one;
   `install --keep-admin` keeps one;
2. otherwise, `--admin-user <name>` plus the password from `MEMHOUSE_ADMIN_PASSWORD`, from
   `--admin-password-file`, or from a prompt.

```bash
with-secret MEMHOUSE_ADMIN_PASSWORD=keychain:pilot/house-admin -- \
  memhouse invite alice --url https://house.example.com --admin-user default
```

Never paste the admin password into an agent's conversation. memhouse ships that
conversation into the house. See [Admin credentials](admin-credentials.md).

Not the admin? `memhouse invite alice --url … --print-sql` prints the statements for
whoever is.

## When the name is taken

`invite` refuses a name whose messages room already holds rows. Inviting into it would
hand the newcomer somebody else's memory, and their first ship would land on top of it.
It suggests another name or another database.

`--adopt` overrides the refusal for one case: **the same person with a new credential**.
For example, someone lost their password and their old machine. The rooms and their
history stay; the new credential takes them over.

**Inviting a ClickHouse user who already exists is refused.** memhouse does not reset an
existing member's password through an invite.

- To change your own password: `memhouse passwd`.
- An administrator resets someone else's: `memhouse passwd --member <name>` with the admin
  credential.

Either way, every machine shipping under the old password fails authentication until its
env file has the new one.

## Seeing who is in a house

```bash
memhouse members                 # every member, and what each one's grants reach
memhouse members --db other      # another database
```

`members` needs the admin credential. A member sees their own grants with
`memhouse whoami`.

## Removing a member

There is no `memhouse` verb for it yet. With the admin credential, `DROP USER <name>`
stops every machine shipping as them. Their rooms stay until you drop them too. See
[Operate a house](operate.md) before you drop anything: there is no undo.
