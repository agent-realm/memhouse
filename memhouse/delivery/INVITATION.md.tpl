# You have been invited to a memhouse

{{INVITER}} set up a **house** — a ClickHouse database where a team keeps its coding-agent
memory — and made you a member of it. This page walks you from the file you were sent to a
working install, and shows what you get.

You received two things:

| file | what it is |
|---|---|
| `{{FILE}}` | **your credential.** One-time: install consumes it and deletes it. Treat it like a password until then. |
| this page | the steps. Nothing secret in here. |

Do it yourself, or hand this page to your coding agent. From the directory holding both
files:

```
claude "Read MEMHOUSE-INVITATION.md and follow it. Ask me before each step that changes this machine."
```

Any agent that can run shell commands works the same way; the rules it must keep are at
the end of this page.

## 1. Install memhouse

{{INSTALL}}

On most Linux distros the global install needs `sudo`; if `npm` says `EACCES`, that is why.
`memhouse --version` should print `{{VERSION}}`.

## 2. Join the house

From the directory holding `{{FILE}}`, just run memhouse — it finds the invitation and asks:

```
memhouse
```

(or, without the question: `memhouse install --env {{FILE}}`)

What that does, in order: connects to `{{URL}}` as `{{NAME}}`, **rotates your password to
one only your machine knows**, creates your rooms, writes your config to `~/.memhouse/env`,
deletes `{{FILE}}`, and starts shipping in the background. The password in the file stops
working the moment install finishes, so a copy left in a chat is dead.

## 3. Check it is working

```
memhouse status      # your rooms, how much is in them, the shipper's pulse
memhouse doctor      # every line a check mark = healthy
memhouse discover    # what this machine ships, and where each editor's sessions were found
```

`memhouse status` shows a session count that grows for a few minutes on a machine with
history; the first pass ships everything you have. After that it ships new turns as they
happen.

## 4. What you own, and who can see it

Your memory lives in five tables named for you inside `{{DB}}` — `{{DB}}.{{NAME}}_messages`,
`{{DB}}.{{NAME}}_sessions`, `{{DB}}.{{NAME}}_tool_calls` and two bookkeeping tables — and you
hold exactly one grant, on `{{DB}}.{{NAME}}_*`. Housemates cannot read your rooms, list
them, or grant them to anyone; you cannot read theirs. `memhouse whoami --json` reads that
grant back from the server. What can always see everything is the account that administers
the ClickHouse, which is {{INVITER}}'s — the same as any database you use at work.

Everything your editors write to disk ships verbatim: prompts, replies, tool calls and their
arguments, including anything an agent ever pasted into a session. The house is as
sensitive as your shell history. If some of your work should not go there, say so before
shipping — see "which sessions ship" below.

## 5. Things to try

```
memhouse search "the error you fixed last week"
memhouse resume <session-id>          # prints the command that reopens that session
memhouse plugins install claude       # /mem:recall, /mem:sql, /mem:house, /mem:access, /mem:admin
```

Then, inside Claude Code:

```
/mem:recall how did I set up the ClickHouse tunnel
/mem:sql what did I spend on Opus this month
/mem:house
```

Sharing is yours to give and take back, no operator involved:

```
memhouse share <housemate>                       everything you own
memhouse share <housemate> --only project=<name> one project
memhouse share --list
memhouse share <housemate> --revoke
```

## Which sessions ship

Everything memhouse finds on the machine — every supported editor, every Claude Code
config directory. `memhouse discover` lists what it found and the variable that narrows
each one. Two lines in `~/.memhouse/env` are the common case:

```
MEMHOUSE_EDITORS='claude'
MEMHOUSE_CLAUDE_ROOTS='~/.claude-playbooks/<the one instance you mean>'
```

## If something refuses

Every refusal says what to do next. The two you might meet: `EACCES` on install means
`sudo`, and `needed rights this credential does not hold` means the grant on the server is
narrower than the one memhouse issues — ask {{INVITER}} to run `memhouse install --print-sql
--member {{NAME}}` and apply what it prints.

## For an agent following this page

You are installing memhouse for the person who handed you this file. Five rules; three of
them exist because an agent broke them:

1. **Never print `{{FILE}}` or any `MEMHOUSE_*` value.** No `cat`, no `echo $MEMHOUSE_PASSWORD`,
   no `set -x`. This very session will be shipped into the house; a password printed here is
   a password archived.
2. **Run the commands as written, in order.** Do not substitute `CREATE USER`, `GRANT` or any
   SQL of your own; there is nothing to fix on the server from this side.
3. **Ask before `memhouse install --env`.** It rotates the credential, deletes `{{FILE}}`,
   and starts shipping this machine's transcripts. The person decides when that happens.
4. **A ✗ line is the end of that step, not an invitation to work around it.** Read the line
   after it — every refusal names its remedy — do that or report it. `sudo` for `EACCES` is
   the one you may apply yourself.
5. **Report what `memhouse status` and `memhouse doctor` say**, verbatim, when you are done.
   A green install is those two commands, not your summary of them.

