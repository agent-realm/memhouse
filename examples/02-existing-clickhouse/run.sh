#!/usr/bin/env bash
# Example 02 — point memhouse at a ClickHouse you already run.
#
# The admin credential builds a member account (rooms mem.<member>_*, one grant on exactly
# those), the install is verified AS that member, and the admin credential is then dropped:
# what stays on disk is the member's. The admin password never touches the command line.
#
#   with-secret MEMHOUSE_ADMIN_PASSWORD=<reference> -- ./run.sh
#   ./run.sh --teardown          stop anything this home started and delete the home
#
# Environment:
#   MEMHOUSE_URL              required  the ClickHouse HTTP endpoint, e.g. https://ch.example.com:8443
#   MEMHOUSE_ADMIN_USER       required  an account that can create users and grant
#   MEMHOUSE_ADMIN_PASSWORD   required  its password — lent by with-secret, never typed into argv
#   MEMBER                    optional  the member to create (default: your login name)
#   MEMHOUSE_BIN              optional  the memhouse command (default: memhouse)
#   EXAMPLE_HOME              optional  where this install lives (default: ~/.memhouse-example-02)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MH=${MEMHOUSE_BIN:-memhouse}
mh() { $MH "$@"; }
export MEMHOUSE_HOME=${EXAMPLE_HOME:-$HOME/.memhouse-example-02}

if [ "${1:-}" = "--teardown" ]; then
  mh stop || true
  rm -rf "$MEMHOUSE_HOME"
  echo "example 02 home removed. The member and its rooms stay in the house; dropping them is an admin's call."
  exit 0
fi

: "${MEMHOUSE_URL:?set MEMHOUSE_URL to your ClickHouse HTTP endpoint}"
: "${MEMHOUSE_ADMIN_USER:?set MEMHOUSE_ADMIN_USER to an account that can create users}"
: "${MEMHOUSE_ADMIN_PASSWORD:?lend it with: with-secret MEMHOUSE_ADMIN_PASSWORD=<reference> -- $0}"
# A login name like "first.last" is not a ClickHouse user name memhouse accepts.
MEMBER=${MEMBER:-$(id -un | tr -c 'A-Za-z0-9_\n' '_' | sed 's/^[^A-Za-z]*//')}
# Only the admin variables and the URL come from outside. A member credential exported
# by some other install would outrank this home's env file.
unset MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB

mkdir -p "$MEMHOUSE_HOME"
FIX="$MEMHOUSE_HOME/example-sessions"
[ -d "$FIX/projects" ] || node "$HERE/../fixtures/make-sessions.js" "$FIX" "$MEMBER" alpha beta >/dev/null

echo "== 1. whoami --admin: is this credential really an administrator?"
mh whoami --admin

echo
echo "== 2. install: build member '$MEMBER' with the admin credential, then verify as the member"
# --editors/--claude-roots keep this example to the made-up sessions above. Drop both to
# ship your real ones. --no-ship: nothing runs in the background; step 3 ships once.
mh install --url "$MEMHOUSE_URL" --admin-user "$MEMHOUSE_ADMIN_USER" --member "$MEMBER" \
  --editors claude --claude-roots "$FIX" --yes --no-ship

# From here on the member credential in the env file is the only one in play.
unset MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD

echo
echo "== 3. make sure every room and stat table exists, then ship once"
# --ensure-schema only creates what is missing, as the member, and ships nothing; it is
# safe to re-run, and the thing to run after an upgrade that adds a table.
mh ship --ensure-schema
mh ship

echo
echo "== 4. whoami: the credential this machine keeps, and what it may do"
mh whoami

echo
echo "== 5. status"
mh status
