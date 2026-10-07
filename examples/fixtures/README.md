# fixtures — made-up sessions

`make-sessions.js` writes a few Claude Code transcripts for one made-up person, laid out
the way Claude Code lays out `~/.claude`, so an example can ship real rows without
shipping your conversations.

```bash
node make-sessions.js <claude-root> <person> [project ...]   # default projects: alpha beta
```

Each project gets one session: a question, a tool call (`memhouse whoami`) and its result,
and an answer. The `alpha` session is about an `ACCESS_DENIED` error and the `beta` one
about rotating a password, so a search can tell them apart. memhouse records the project
as the last segment of the session's folder (`/home/<person>/work/alpha`), which is what a
scoped share like `--only project=alpha` matches.

Point memhouse at the directory, and at nothing else, with:

```bash
MEMHOUSE_EDITORS=claude MEMHOUSE_CLAUDE_ROOTS=<claude-root> memhouse ship
```

or persist the same scope at install time with `--editors claude --claude-roots <claude-root>`.
The script prints one line per session: `<project> <session-id>`.
