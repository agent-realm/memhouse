# Your memhouse moved — one command brings you along

{{OPERATOR}} upgraded the house at `{{URL}}` to memhouse's **one layout**. Your memory is
all still there; only its address changed. Where you had a database of your own
(`{{NAME}}.messages`), you now have rooms named for you inside the shared house:

```
{{ROOMS}}
```

Nothing was copied or deleted — the tables were renamed in place. Your shares were carried
over by the operator. Until you upgrade, your shipper stops adding new sessions (it refuses
the old address rather than writing somewhere wrong); nothing is lost meanwhile.

Do it yourself, or hand this page to your coding agent, from any directory:

```
claude "Read MEMHOUSE-UPGRADE.md and follow it. Ask me before each step that changes this machine."
```

## 1. Upgrade

```
memhouse update
```

That installs the new build from the channel you are on ({{CHANNEL}}), notices that your
rooms moved, rewrites `~/.memhouse/env` to point at house `{{DB}}`, refreshes the `/mem`
skills in your Claude config, and restarts the shipper. If `memhouse` is not installed on
this machine at all: `npm install -g memhouse@{{CHANNEL}}`, then `memhouse status`.

## 2. Check

```
memhouse instance
memhouse status
```

`instance` should say house `{{DB}}`, member `{{NAME}}`, rooms `{{DB}}.{{NAME}}_*`, shipper
running. `status` shows your session count — the same as before — and, after a few
minutes, a fresh pass.

## 3. What is different

- **Reading a housemate.** In `/mem:recall`, a friend's memory is `{{DB}}.<friend>_messages`
  — no database switch. `/mem:house` lists who can read yours.
- **The dashboard** (`memhouse start`, then the printed URL) is faster: the tables it reads
  are now filled by your own shipper at the end of each pass.
- **Nothing to re-share.** Grants you gave or received were re-expressed on the new names.

## If something looks wrong

- `memhouse status` says *"last pass FAILED"* → `memhouse stop && memhouse start`.
- `memhouse update` says it is *already current* but `instance` still shows house `{{NAME}}`
  → run `memhouse doctor`; it names the fix.
- Anything else: send {{OPERATOR}} the output of `memhouse doctor` — it prints no secrets.

## For an agent following this page

- Never print `~/.memhouse/env` or any `MEMHOUSE_*` value; the transcript you are in is
  itself shipped into this house.
- Run exactly the commands above. Do not create or drop tables, do not edit the env by
  hand — `memhouse update` does the rewrite, and `memhouse doctor` names any remaining fix.
- If `memhouse update` needs `sudo` (an `EACCES` from npm), that is the one place it is fine.
- Stop and show the person the output when anything says ✗.

memhouse {{VERSION}} · generated {{DATE}}
