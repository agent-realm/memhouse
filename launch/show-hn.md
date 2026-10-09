# Show HN draft — post when the repo flips public

Not in the npm tarball (the `files` whitelist excludes `launch/`). Post title and body
below; the notes after them are for whoever presses submit.

---

## Title

> Show HN: Memhouse – Claude Code deletes your transcripts after 30 days. I keep them

(HN truncates around 80 chars; this is 79. Fallback if a mod edits: "Show HN:
Memhouse – durable, searchable memory for 17 coding agents, in your ClickHouse")

## Body

Claude Code silently deletes session transcripts after 30 days
(`cleanupPeriodDays`, default 30). I found this out the honest way: months of
daily use, and the oldest transcript left on my machine was nine days old. Every
bug I'd fixed before that, every decision, every "didn't we solve this already?"
— gone locally. The demo that sold me on my own tool was searching my July
history and realizing the laptop no longer had it; only the house did.

memhouse reads the session files your coding agents already write — 17 editors:
Claude Code, Codex, Cursor, Zed, Copilot, Gemini CLI, OpenCode, Goose and the
rest — parses them locally, and ships typed rows into a ClickHouse you own.
Install is one command, no flags, no native builds (`node:sqlite` did that for
us). No cloud, no telemetry, no LLM in the pipeline: capture is deterministic
parsing, so it cannot hallucinate, cannot truncate a summary, and costs nothing
per event.

What you get: full-text search over every session you've ever had, on any
machine; `memhouse resume <id>` prints the exact command that reopens that
conversation in the editor it came from; a dashboard with per-model/per-editor
cost analytics; Claude Code skills so the agent can query its own history; and a
read-only SQL surface when you want real questions answered.

The part I think is genuinely new: **teams with attribution the server enforces.**
A team's house is one database. Everyone's shipper writes into the same three
their own rooms, and every row carries `user_id` stamped by ClickHouse itself
(`MATERIALIZED currentUser()` — async inserts are pinned off so the stamp can't be
skipped) plus a per-install host fingerprint. `WHERE user_id = 'alice'` is one
person; `WHERE host = '…'` is one machine. Joining is the statements any DBA already
knows: `CREATE USER` + a `GRANT` per room. No row policies, no sync service, no
per-seat pricing — and a teammate can run `SHOW GRANTS` and see exactly what they
hold, rather than being asked to trust a filter they cannot inspect.

Design choices people will ask about:

- *Why ClickHouse and not SQLite?* Because "search all my sessions" is an
  analytics query, teams need a server anyway, and `deploy --local` stands up a
  loopback-bound container in one command if you don't have one.
- *Why no LLM compression like claude-mem?* Because an LLM in the write path
  fails silently — the incumbent's own tracker shows truncated and orphaned
  observations. memhouse keeps the ground truth; summarization can be layered on
  later, and deleting a paraphrase you can't regenerate is not a trade I'll make
  with your history.
- *Why pull-based recall?* Deliberate for now; a SessionStart context injection
  (a ~300-token index, no LLM) is on the roadmap.
- *Redaction?* We ship what your editor already wrote to disk, verbatim. The
  house is as sensitive as your shell history — place it accordingly. SECURITY.md
  states the whole model without varnish.

Apache-2.0, built on the adapter and dashboard heritage of agentlytics (MIT) (credited in the
repo). macOS and Linux are real today; Windows is freshly tested (see the support
matrix). Everything — including the acceptance suite an agent drives against a
throwaway ClickHouse, and the git-history secret scan we ran before opening the
repo — is in the tree.

https://github.com/agent-realm/memhouse · https://memhouse.io

## Submit-time notes (not part of the post)

- Do NOT post until: repo public, v1.0.0 tagged, Windows row updated from the
  pilot's Monday pass, and the SessionStart hook either shipped or the roadmap
  line above kept honest.
- Post as a plain Show HN link to the repo, body as the first comment if the
  text field is skipped — HN convention tolerates either; the first comment
  survives edits better.
- First-hour objections to expect, with the honest answers already in the body:
  "just use claude-mem" (LLM write path + no teams + paid multi-device),
  "SQLite would do" (analytics + teams), "Node install weight" (one command,
  zero native deps as of 0.9.0), "another memory tool" (the 30-day fact is the
  hook — nobody else leads with it, verified 2026-08-15 against docs and a real
  machine).
- The founder should be running memhouse on their own machine before posting.
