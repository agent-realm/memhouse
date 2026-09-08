# memhouse — agent install prompt (template)

`memhouse prompt --install` renders this with THIS machine's facts substituted and
prints it. Feed the output to a coding agent; it has everything needed to install and
onboard without asking the user to look anything up.

The point of rendering rather than shipping a static runbook: the CLI has already
probed the machine, so the prompt states the route that applies instead of making the
agent reason through a decision tree and possibly pick wrong. `AGENT-INSTALL.md` is the
static long-form version, and it predates `deploy --local`.

Placeholders are `{{NAME}}`. Everything below the marker is the prompt body.

<!-- PROMPT BODY BELOW -->
You are installing **memhouse** for the user on this machine.

memhouse gives a coding agent long-term memory of past sessions. It reads the session
transcripts your editors already write to disk — 17 of them — parses them locally, and
ships typed rows into ClickHouse. Nothing is intercepted or proxied; it reads files that
already exist.

## What this machine looks like right now

- memhouse version: **{{VERSION}}**
- platform: {{PLATFORM}}, node {{NODE}}
- current state: **{{STATE}}**
- editors with sessions found: {{EDITORS}}
- reachable ClickHouse: {{HOUSE}}
- container engines available: {{ENGINES}}

## Your task

{{PLAN}}

## Rules that matter

- **Never invent a credential.** If a step needs a password for a house the user already
  runs, ask them for it. Do not guess, do not read it out of a file they did not name.
- **Do not run `deploy --down`.** It destroys the container *and its volume*. It is never
  part of an install.
- The install writes `{{ENV_FILE}}` at mode 0600. Do not print its contents; do not
  echo a password into the transcript you are writing, which memhouse will then ship.
- If a command fails, read what it printed before retrying. memhouse's failures name the
  cause and usually name the fix — it is not a generic tool that fails generically.
- The house's rooms are three PLAIN, SHARED tables — `sessions`, `messages`,
  `tool_calls` — in the connection's database, carrying your own prefix if this is a
  shared house (`alice_messages`). `memhouse rooms` prints what yours are called.
  Direct reads of `messages`/`tool_calls` must filter to the current parse (the shipper
  retains superseded parses under an `epoch` column); the installed skills carry the
  filter, so prefer them for queries.
- If `ship` refuses with "wrong sorting key … memhouse migrate", the house was built by
  an older memhouse. Run `memhouse migrate` — it copies, swaps atomically, deletes
  nothing, and shipping resumes on its own. Do NOT try to rebuild tables by hand.

## When you are done

Run `memhouse doctor` and report its output to the user. Every line should be a check
mark. Then tell them:

- where the dashboard is (`http://localhost:{{PORT}}`) and that `memhouse start` runs it
- that `memhouse search <terms>` searches every past session from every editor
- that `memhouse plugins install claude` gives their agents /mem:recall, /mem:sql,
  /mem:house, /mem:access and /mem:admin — offer to run it
- that you can now search their history yourself, and offer to try one query

If `doctor` reports a failure, say which line failed and what memhouse suggested. Do not
declare success on a partial install.
