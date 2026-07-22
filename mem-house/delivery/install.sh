#!/usr/bin/env bash
# mem-house standalone installer.
#
# Checks node >= 20 and a reachable ClickHouse, writes ~/.memhouse/env
# (MEMHOUSE_* vars), applies the house schema via the shipper
# (`ship.js --ensure-schema`), runs a first ship, and prints how to start the
# dashboard and set up continuous shipping (`--loop`).
#
# Usage:
#   ./install.sh                                  # interactive (prompts for missing values)
#   ./install.sh --url http://localhost:8123 --user memhouse_root --password 'pw' --db memhouse
#   ./install.sh --yes                            # non-interactive, defaults / env / existing env file
#
# Flags:
#   --url URL         ClickHouse HTTP(S) endpoint   (default http://localhost:8123)
#   --user USER       ClickHouse user               (default memhouse_root; 'default' works for a local CH)
#   --password PW     credential                    (default empty)
#   --db DB           the house (database)          (default memhouse)
#   --port PORT       dashboard/API port            (default 4640)
#   --yes             never prompt; take flags > current env > ~/.memhouse/env > defaults
#   --no-ship         stop after writing env + ensure-schema (skip the first ship)
#
# Defaults resolve in order: flag > MEMHOUSE_* already in the environment >
# existing ~/.memhouse/env > built-in default. Runs from any cwd — the repo is
# resolved from this script's own location (mem-house/delivery/ -> repo root).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SHIP="$REPO_ROOT/mem-house/shipper/ship.js"
SERVER="$REPO_ROOT/mem-house/server/server.js"
ENV_DIR="$HOME/.memhouse"
ENV_FILE="$ENV_DIR/env"

die() { echo "install.sh: $*" >&2; exit 1; }
info() { echo "== $*"; }

# ---------- 0. defaults: existing env file, then environment ----------------
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
CH_URL="${MEMHOUSE_URL:-http://localhost:8123}"
CH_USER="${MEMHOUSE_USER:-memhouse_root}"
CH_PASSWORD="${MEMHOUSE_PASSWORD:-}"
CH_DB="${MEMHOUSE_DB:-memhouse}"
DASH_PORT="${MEMHOUSE_PORT:-4640}"

ASSUME_YES=0
NO_SHIP=0
URL_SET=0; USER_SET=0; PASS_SET=0; DB_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url)      CH_URL="${2:?--url needs a value}"; URL_SET=1; shift 2;;
    --user)     CH_USER="${2:?--user needs a value}"; USER_SET=1; shift 2;;
    --password) CH_PASSWORD="${2:?--password needs a value}"; PASS_SET=1; shift 2;;
    --db)       CH_DB="${2:?--db needs a value}"; DB_SET=1; shift 2;;
    --port)     DASH_PORT="${2:?--port needs a value}"; shift 2;;
    --yes|-y)   ASSUME_YES=1; shift;;
    --no-ship)  NO_SHIP=1; shift;;
    -h|--help)  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown flag: $1 (try --help)";;
  esac
done

# ---------- 1. node >= 20 ---------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found (need node >= 20; https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || die "node >= 20 required (found $(node -v))"
info "node $(node -v) ok"

[ -f "$SHIP" ] || die "shipper not found at $SHIP (incomplete checkout?)"

# ---------- 2. repo dependencies -------------------------------------------
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  info "installing npm dependencies (first run)"
  (cd "$REPO_ROOT" && npm install --no-audit --no-fund)
fi

# ---------- 3. gather connection values -------------------------------------
prompt() { # prompt <question> <current> -> stdout
  local ans
  read -r -p "$1 [$2]: " ans
  echo "${ans:-$2}"
}
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  [ "$URL_SET"  -eq 1 ] || CH_URL="$(prompt "ClickHouse URL" "$CH_URL")"
  [ "$USER_SET" -eq 1 ] || CH_USER="$(prompt "ClickHouse user" "$CH_USER")"
  if [ "$PASS_SET" -eq 0 ]; then
    read -r -s -p "ClickHouse password [keep current/empty]: " ans; echo
    [ -n "$ans" ] && CH_PASSWORD="$ans"
  fi
  [ "$DB_SET" -eq 1 ] || CH_DB="$(prompt "House (database)" "$CH_DB")"
fi

# ---------- 4. ClickHouse reachable? ----------------------------------------
info "checking ClickHouse at $CH_URL (user $CH_USER)"
ONE="$(curl -sS --connect-timeout 5 --fail-with-body \
        --user "$CH_USER:$CH_PASSWORD" \
        --data-binary "SELECT 1" "$CH_URL")" \
  || die "ClickHouse not reachable at $CH_URL with those credentials"
[ "$ONE" = "1" ] || die "unexpected reply from $CH_URL: $ONE"
info "ClickHouse ok"

# Ensure the house exists before ensure-schema (schema.sql is unqualified and the
# shipper binds to MEMHOUSE_DB — on a virgin standalone server the database must
# be created first). On a kernel realm the house is already provisioned; if the
# user lacks CREATE DATABASE but the house is reachable, that's fine too.
case "$CH_DB" in
  (*[!A-Za-z0-9_]*|'') die "invalid database name '$CH_DB' — use letters, digits, underscore" ;;
esac
if ! curl -fsS --max-time 20 --user "$CH_USER:$CH_PASSWORD" \
      --data-binary "CREATE DATABASE IF NOT EXISTS $CH_DB" "$CH_URL" >/dev/null 2>&1; then
  curl -fsS --max-time 20 --user "$CH_USER:$CH_PASSWORD" \
      --data-binary "SELECT 1" "$CH_URL/?database=$CH_DB" >/dev/null 2>&1 \
    || die "house '$CH_DB' does not exist and cannot be created as $CH_USER"
fi
info "house '$CH_DB' ready"

# ---------- 5. write ~/.memhouse/env ----------------------------------------
mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"
cat > "$ENV_FILE" <<EOF
# mem-house connection (written by install.sh $(date +%Y-%m-%d-%H_%M)). NEVER commit.
MEMHOUSE_URL=$CH_URL
MEMHOUSE_USER=$CH_USER
MEMHOUSE_PASSWORD=$CH_PASSWORD
MEMHOUSE_DB=$CH_DB
MEMHOUSE_PORT=$DASH_PORT
EOF
chmod 600 "$ENV_FILE"
info "wrote $ENV_FILE"

export MEMHOUSE_URL="$CH_URL" MEMHOUSE_USER="$CH_USER" \
       MEMHOUSE_PASSWORD="$CH_PASSWORD" MEMHOUSE_DB="$CH_DB" \
       MEMHOUSE_PORT="$DASH_PORT"

# ---------- 6. schema + first ship ------------------------------------------
info "applying house schema (ship.js --ensure-schema)"
node "$SHIP" --ensure-schema \
  || die "ensure-schema failed. If $CH_USER cannot CREATE DATABASE, create '$CH_DB' first (or, on a kernel realm, provision the agency: see delivery/kernel-install.md), then re-run."

if [ "$NO_SHIP" -eq 0 ]; then
  info "first ship (this parses local editor sessions and may take a while)"
  node "$SHIP"
else
  info "skipping first ship (--no-ship)"
fi

# ---------- 7. next steps ----------------------------------------------------
cat <<EOF

mem-house installed.

  env file     $ENV_FILE
  house        $CH_DB @ $CH_URL

Next steps:

  # dashboard (agentlytics UI over the house) -> http://localhost:$DASH_PORT
  node "$SERVER"

  # keep shipping continuously (re-ships incrementally; Ctrl-C to stop)
  node "$SHIP" --loop
  # background it:
  nohup node "$SHIP" --loop >> "$ENV_DIR/ship.log" 2>&1 &

  # agent skills (search/sessions/sql from inside Claude Code):
  node "$REPO_ROOT/bin/memhouse.js" plugins install claude
  # -> installs memhouse-search / memhouse-sessions / memhouse-sql into
  #    \${CLAUDE_CONFIG_DIR:-\$HOME/.claude}/skills (loads next session)

Verify anytime:
  set -a; . "$ENV_FILE"; set +a
  curl -sS --user "\$MEMHOUSE_USER:\$MEMHOUSE_PASSWORD" --data-binary \\
    "SELECT count() FROM sessions" "\$MEMHOUSE_URL/?database=\$MEMHOUSE_DB&final=1"
EOF
