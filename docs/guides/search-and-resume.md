# Search, resume and skills

## Search

```bash
memhouse search "connection refused"
memhouse search clickhouse auth --limit 50
```

This is a full-text search across every session in your rooms, from every machine and
every editor. Each hit names the session id, project, date and the matching line.

## Resume

```bash
memhouse resume claude:6b1f…
#   cd /path/to/project && claude --resume 6b1f…
```

`resume` **prints** the command and does not run it. A resume from the wrong directory,
or with a stale id, does not fail: it opens a **new** session, and the tool reports
success while the transcript you wanted is still gone. Printing it lets you see the
directory and the id first.

| editor | resume |
|---|---|
| Claude Code, Codex, OpenCode | verified: prints the command |
| Cursor, Zed, VS Code, Kiro, Copilot for JetBrains, Antigravity, Devin | no CLI that takes a session id; `resume` says so |
| goose, Gemini CLI, Cursor Agent, Copilot CLI | refused as *unverified*: nobody has confirmed the flag from the tool's own `--help` yet |

## Numbers

```bash
memhouse stats              # sessions, messages and tokens per editor
memhouse sessions-query     # the per-session rollup as SQL, to paste into your own queries
```

The dashboard (`memhouse start`, then http://localhost:4640) shows the same and more:

- cost by model, editor and project;
- tool-call rankings;
- activity over time;
- which machine wrote what.

**Some editors record no token usage.** Kiro, VS Code, Zed and one of Cursor's two
storage paths extract none, so their cost shows as zero. Read that as *unknown*, not
*free*.

## Skills for your agents

```bash
memhouse plugins install claude     # every Claude Code config dir found; choose, or --yes for all
memhouse plugins install claude --target ~/.claude
memhouse plugins list
memhouse plugins remove claude
```

The five skills:

| skill | for |
|---|---|
| `/mem:recall` | answer a question from past sessions: search, read the transcripts, answer, cite |
| `/mem:house` | is memory working, what does the house hold, which machines write, who can read it |
| `/mem:sql` | read-only SQL for numbers: spend, models, tools, activity |
| `/mem:access` | invite someone, share your house, list or revoke shares |
| `/mem:admin` | operate the server as its administrator, without the password entering the conversation |

`plugins install` acts on **every** Claude Code config directory on the machine:
`~/.claude`, whatever `CLAUDE_CONFIG_DIR` points at, and each playbook under
`~/.claude-playbooks/`. All are selected by default. Installing into the default config
alone is how `/mem:recall` ends up missing from the playbook you actually work in, and a
missing skill never announces itself.

For an agent that does not use Claude Code skills, `memhouse prompt` prints a snippet for
its system prompt: where memory lives and how to query it.

## Writing your own queries

The rooms are documented column by column in
[`memhouse/house/HOUSE.md`](../../memhouse/house/HOUSE.md). Two rules matter for every
query:

1. **Join on `(session_id, user_id)`**, never on `session_id` alone. Two members' editors
   can produce the same local session id.
2. **Filter to the current parse.** A session's rows can hold more than one parse (an
   `epoch`; see [How memory is stored](storage.md)). Counts must keep only the newest:

   ```sql
   WHERE origin != 'ship'
      OR (session_id, user_id, epoch) IN (
           SELECT session_id, user_id, max(epoch) FROM mem.<you>_messages
           WHERE origin = 'ship' GROUP BY session_id, user_id)
   ```

Read with `FINAL`, or the `final=1` setting, so that ReplacingMergeTree versions collapse.
