#!/usr/bin/env bash
# Example 01 — one person, one machine.
#
# A house in a local container, two made-up sessions shipped into it, then read back.
# Runs in its own memhouse home, so an install you already have is never touched.
#
#   ./run.sh              build it and show it
#   ./run.sh --teardown   stop the shipper, remove the container and its volume, delete the home
#
# Environment (all optional):
#   MEMHOUSE_BIN    the memhouse command            (default: memhouse)
#   EXAMPLE_HOME    where this example's install lives (default: ~/.memhouse-example-01)
#   HOUSE_PORT      the local port ClickHouse binds  (default: 8123)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MH=${MEMHOUSE_BIN:-memhouse}
mh() { $MH "$@"; }

# Only this example's home speaks. An exported credential from another install would
# otherwise outrank the home's own env file (flags > MEMHOUSE_* > env file).
unset MEMHOUSE_URL MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD
export MEMHOUSE_HOME=${EXAMPLE_HOME:-$HOME/.memhouse-example-01}
HOUSE_PORT=${HOUSE_PORT:-8123}

if [ "${1:-}" = "--teardown" ]; then
  mh stop || true
  mh deploy --down --yes
  rm -rf "$MEMHOUSE_HOME"
  echo "example 01 removed"
  exit 0
fi

mkdir -p "$MEMHOUSE_HOME"

# Made-up sessions, and nothing else: the shipper reads only this directory.
FIX="$MEMHOUSE_HOME/example-sessions"
if [ ! -d "$FIX/projects" ]; then
  echo "== writing two made-up Claude Code sessions to $FIX"
  node "$HERE/../fixtures/make-sessions.js" "$FIX" me alpha beta
fi
export MEMHOUSE_EDITORS=claude MEMHOUSE_CLAUDE_ROOTS="$FIX"

echo "== 1. a house: ClickHouse in a container, bound to loopback, plus the install"
mh deploy --local --house-port "$HOUSE_PORT"

echo
echo "== 2. one shipping pass (deploy also started a background shipper; this one is in the foreground)"
mh ship

echo
echo "== 3. what the house holds"
mh status

echo
echo "== 4. find a past conversation"
mh search ACCESS_DENIED

echo
echo "Done. Open the dashboard:  MEMHOUSE_HOME=$MEMHOUSE_HOME $MH start   (then http://localhost:4640)"
echo "Remove everything:        $0 --teardown"
