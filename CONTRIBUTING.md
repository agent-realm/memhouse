# Contributing to memhouse

## Architecture

```
editor files/DBs → editors/*.js → memhouse/shipper/ship.js → ClickHouse rooms
                                → memhouse/server/ (REST) → ui/ (React SPA)
```

1. **Editor adapters** (`editors/*.js`) — read sessions from local files, SQLite stores,
   or a running language server. This is the layer worth contributing to.
2. **Shipper** (`memhouse/shipper/ship.js`) — runs the adapters, normalizes to typed rows,
   and writes them into the caller's own rooms. No LLM, no server component.
3. **Rooms** (`memhouse/per-member/`) — `sessions_<member>`, `messages_<member>`,
   `tool_calls_<member>` in the `mem` database. See
   [`memhouse/per-member/SCHEMA.md`](memhouse/per-member/SCHEMA.md); there is no local
   SQLite cache.
4. **Server + SPA** (`memhouse/server/`, `ui/`) — the dashboard.

## Development setup

```bash
git clone https://github.com/agent-realm/memhouse.git
cd memhouse && npm install          # two runtime deps, no native build

node bin/memhouse.js discover       # read-only: what this machine has
node bin/memhouse.js --help
npm test                            # syntax gate + unit checks

cd ui && npm run dev                # SPA on 5173, proxying /api to the server
```

Nothing here compiles. SQLite comes from `node:sqlite`, which is part of Node — hence
the `engines: >=24` floor, where it is stable rather than warning. There is no install
script to allow, in a checkout or from npm.

---

## Adding a new editor

1. Create `editors/<name>.js` with the adapter interface:

```javascript
module.exports = {
  name: 'my-editor',
  // Optional: list of source IDs this adapter handles
  // sources: ['my-editor', 'my-editor-beta'],

  getChats() {
    return [{
      source: 'my-editor',       // editor identifier — see the note below
      composerId: '...',          // unique chat ID
      name: '...',                // chat title (nullable)
      createdAt: 1234567890,      // timestamp in ms (nullable)
      lastUpdatedAt: 1234567890,  // timestamp in ms (nullable)
      mode: 'agent',              // session mode (nullable)
      folder: '/path/to/project', // working directory (nullable)
      encrypted: false,           // true if messages can't be read
      bubbleCount: 10,            // message count hint (nullable)
    }];
  },

  getMessages(chat) {
    return [{
      role: 'user',           // 'user' | 'assistant' | 'system' | 'tool'
      content: '...',         // message text
      _model: 'gpt-4',       // model name (optional)
      _inputTokens: 500,     // input token count (optional)
      _outputTokens: 200,    // output token count (optional)
      _cacheRead: 100,        // cache read tokens (optional)
      _cacheWrite: 50,        // cache write tokens (optional)
      _toolCalls: [{          // tool calls (optional)
        name: 'read_file',
        args: { path: '/foo.js' },
      }],
    }];
  },
};
```

2. Register in `editors/index.js`.
3. Add a colour and label in `ui/src/lib/constants.js`.
4. **Put the `source` string in a bucket in [`memhouse/resume.js`](memhouse/resume.js)** —
   resumable (with the flag read out of the CLI's own `--help`), no-CLI, or unverified.
   `npm test` fails until you do; that is deliberate.

### `name` is not `source`

The module's `name` and the `source` on each chat are **different strings**, and `source`
is the one that lands in the database and in every `session_id`. `editors/claude.js` is
`const name = 'claude'` and emits `source: 'claude-code'`. Getting this wrong is silent.

### A failed read must write nothing

The hardest-won rule in this codebase, and the reason `editors/adapter-errors.js` exists.

An adapter that cannot read a session must **record the failure and return nothing** — never
an empty array, never a partial transcript. A partial read gets shipped, the stored
`message_count` is written from the partial rows, and the incremental skip predicate then
withholds that session on every later pass: the truncation becomes permanent *and* the
warning stops. Report through `adapterErrors.record()` and let the shipper retry.

The same applies to counts: a failed count is **not** a count of zero. Set `_countUnknown`
so the skip predicate refuses to skip, or the session goes stale forever.

Fix a defect of this shape across **all** adapters and **both** storage paths in one pass —
four separate review rounds here caught the same bug fixed in one adapter and not its
siblings. And check discovery-time omissions separately from read-time failures: a session
dropped while listing never reaches `doctor`'s probes at all.

---
## Editor Adapter Details

### Cursor

Reads from **two separate data stores**:

1. **Agent Store** (`~/.cursor/chats/<workspace>/<chatId>/store.db`)
   - SQLite with `meta` table (hex-encoded JSON) and `blobs` table (content-addressed SHA-256 tree)
   - Meta contains: `agentId`, `latestRootBlobId`, `name`, `createdAt`
   - Messages retrieved by walking the blob tree: tree nodes contain message refs and child refs
   - Tool calls extracted from OpenAI-format `tool_calls` array on assistant messages

2. **Workspace Composers** (`~/Library/Application Support/Cursor/User/`)
   - `workspaceStorage/<hash>/state.vscdb` — `composer.composerData` key holds all composer headers
   - `globalStorage/state.vscdb` — `cursorDiskKV` table with `bubbleId:<composerId>:<n>` keys
   - Each bubble is JSON with `type` (1=user, 2=assistant), `text`, `toolFormerData`, `tokenCount`
   - Tool args from `toolFormerData.rawArgs` with fallback to `toolFormerData.params`

**Limitations:** Cursor does not persist model names per message. Provider name (e.g., "anthropic") extracted from `providerOptions` when available.

### Devin / Devin Next / Antigravity

Connects to the **running language server** via ConnectRPC (buf Connect protocol):

1. Discovers process via `ps aux` — finds `language_server_macos_arm` with `--csrf_token`
2. Extracts CSRF token and PID, finds listening port via `lsof`
3. `GetAllCascadeTrajectories` → session summaries
4. `GetCascadeTrajectory` → full conversation steps

**Requires the application to be running.** Data is served from the language server process, not from files on disk. Antigravity uses HTTPS.

### Claude Code

Reads from `~/.claude/projects/<encoded-path>/`:
- `sessions-index.json` — session index with titles and timestamps
- Individual `.jsonl` session files — each line is a JSON message with `type`, `role`, `content`, `model`, `usage`
- Tool calls extracted from `tool_use` content blocks and `tool_result` messages

### Codex

Reads from `${CODEX_HOME:-~/.codex}/sessions/**/*.jsonl`:
- `session_meta` — session metadata including `id`, `cwd`, raw `source`, `originator`, and `cli_version`
- `turn_context` — per-turn state such as the current `model`
- `response_item` — visible transcript items for user/assistant messages, reasoning summaries, and tool calls
- `event_msg` where `payload.type === "token_count"` — token usage deltas or cumulative totals

Adapter behavior:
- Titles come from the first meaningful user prompt, skipping Codex bootstrap wrappers like `<user_instructions>` and `<environment_context>`
- Reasoning summaries render as `[thinking] ...`; encrypted reasoning is ignored
- `function_call`, `custom_tool_call`, and `web_search_call` become visible `[tool-call: ...]` transcript lines and populate `_toolCalls` analytics
- `function_call_output` and `custom_tool_call_output` become condensed `[tool-result: ...]` transcript lines
- Token usage prefers `last_token_usage`; when only `total_token_usage` exists, the adapter diffs against the previous cumulative totals
- Models are carried forward from the latest `turn_context`; if none is available, the session still ingests but leaves `_model` unset

### VS Code / VS Code Insiders

Reads from `~/Library/Application Support/{Code,Code - Insiders}/User/`:
- `workspaceStorage/<hash>/state.vscdb` — workspace-to-folder mapping
- Chat sessions stored as `.jsonl` files in the Copilot Chat extension directory
- JSONL reconstruction: `kind:0` = init state, `kind:1` = JSON patch at key path
- Messages, tool calls, and token usage extracted from reconstructed state

### Zed

Reads from `~/Library/Application Support/Zed/threads/threads.db`:
- SQLite database with `threads` table containing zstd-compressed JSON blobs
- Each thread decompressed via `zstd` CLI
- Messages in OpenAI format with `tool_calls` array on assistant messages

### OpenCode

Reads from `~/.local/share/opencode/opencode.db`:
- SQLite database with `session`, `message`, and `project` tables
- Messages queried directly via SQL with full content, model, and token data

---

---

## Where the data goes

There is no local cache database. Rows land in ClickHouse, one set of rooms per member —
`sessions_<member>`, `messages_<member>`, `tool_calls_<member>` — with the column list,
sort keys and the `origin` guarantees in
[`memhouse/per-member/SCHEMA.md`](memhouse/per-member/SCHEMA.md).

Two properties to respect when touching the write path:

- **`origin`** separates rows the shipper wrote from rows imported from elsewhere. The
  shipper's clear binds `origin='ship'`; without that bind a re-ship destroys imported
  history it cannot reproduce.
- **`user_id MATERIALIZED currentUser()`** is stamped by the server. Never send it, and
  never trust a member-supplied identity.
