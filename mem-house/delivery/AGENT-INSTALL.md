# mem-house — agent install

Imperative steps for an AI coding agent installing mem-house on a machine. Execute
in order; every command is copy-pasteable. Prereqs: Node >= 20.19, a reachable
ClickHouse >= 26.2 (local server, Cloud, or a kernel house — see
`kernel-install.md` for the kernel path), and this repo checked out.

## 1. Install

```bash
cd <repo>            # the memhouse checkout
npm install --no-audit --no-fund
```

## 2. Configure the connection

Write `~/.memhouse/env` (the installer can do this interactively — `bash
mem-house/delivery/install.sh` — or write it yourself):

```bash
mkdir -p ~/.memhouse
cat > ~/.memhouse/env <<'EOF'
MEMHOUSE_URL=http://localhost:8123
MEMHOUSE_USER=memhouse_root
MEMHOUSE_PASSWORD=<credential>
MEMHOUSE_DB=memhouse
EOF
chmod 600 ~/.memhouse/env
```

## 3. Create the schema and run the first ship

```bash
set -a; source ~/.memhouse/env; set +a
node mem-house/shipper/ship.js --ensure-schema
node mem-house/shipper/ship.js            # first full parse-on-client ship
```

Expected output shape: `[mem-house] shipped N sessions (0 skipped) → M msg rows, T
tool rows in Xs` with N in the hundreds on a machine with real agent usage.

## 4. Verify

```bash
node mem-house/shipper/ship.js --stats
```

Expect one row per source (claude-code, codex, gemini-cli, …) with non-zero
sessions/messages. Or verify by SQL:

```bash
curl -s -u "$MEMHOUSE_USER:$MEMHOUSE_PASSWORD" "$MEMHOUSE_URL/?database=$MEMHOUSE_DB" \
  --data-binary "SELECT source, count() FROM sessions_v GROUP BY source SETTINGS final=1 FORMAT PrettyCompact"
```

## 5. Start the dashboard (optional)

```bash
cd ui && npm install && npm run build && cd ..   # first time only (builds public/)
node mem-house/server/server.js                  # → http://localhost:4640
```

## 6. Keep it fresh

Re-ship on a schedule (incremental — cheap):

```bash
node mem-house/shipper/ship.js --loop 300 &
```

## 7. Install the skills (optional, for Claude Code)

Copy `mem-house/delivery/skills/*` into the target agent's skills directory
(e.g. `$CLAUDE_CONFIG_DIR/skills/`), or install `mem-house/delivery/plugin/` as a
Claude Code plugin. The skills read the connection from `~/.memhouse/env`.
