#!/usr/bin/env bash
# Example 03 — a team house: one admin, three members, two kinds of share.
#
# The admin invites alice, bob and carol into one house. Each installs from their invite
# file into a home of their own (standing in for three laptops), and ships made-up
# sessions. Then alice shares: everything with bob, project `alpha` only with carol. The
# script reads with each person's own credential to show what they can and cannot see,
# and finally revokes both shares.
#
# Run it against a THROWAWAY ClickHouse — a lab, a scratch container. It refuses to start
# if users named alice, bob or carol already exist.
#
#   with-secret MEMHOUSE_ADMIN_PASSWORD=<reference> -- ./run.sh
#   KEEP=1 ...  keep the three members and their rooms afterwards (default: removed)
#
# Environment:
#   MEMHOUSE_URL              required  the house's HTTP endpoint, as the members will reach it
#   MEMHOUSE_ADMIN_USER       required  an account that can create users and grant
#   MEMHOUSE_ADMIN_PASSWORD   required  its password — lent by with-secret, never on argv
#   MEMHOUSE_BIN              optional  the memhouse command (default: memhouse)
#   EXAMPLE_DIR               optional  where the three homes live (default: a new temp dir)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MH=${MEMHOUSE_BIN:-memhouse}
mh() { $MH "$@"; }
: "${MEMHOUSE_URL:?set MEMHOUSE_URL to the house endpoint the members will use}"
: "${MEMHOUSE_ADMIN_USER:?set MEMHOUSE_ADMIN_USER}"
: "${MEMHOUSE_ADMIN_PASSWORD:?lend it with: with-secret MEMHOUSE_ADMIN_PASSWORD=<reference> -- $0}"
unset MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB
URL=$MEMHOUSE_URL
WORK=${EXAMPLE_DIR:-$(mktemp -d)}
mkdir -p "$WORK"
PEOPLE="alice bob carol"

# SQL over HTTP with the password fed to curl on stdin (-K -), so it is never in argv.
admin_q() {
  printf 'user = "%s:%s"\n' "$MEMHOUSE_ADMIN_USER" "$MEMHOUSE_ADMIN_PASSWORD" \
    | curl -sS -K - --data-binary "$1" "$URL/"
}
# The same, as one member, with the credential their own install keeps.
as() {
  local who=$1 sql=$2
  ( set -a; . "$WORK/$who/env"; set +a
    printf 'user = "%s:%s"\n' "$MEMHOUSE_USER" "$MEMHOUSE_PASSWORD" ) \
    | curl -sS -K - --data-binary "$sql" "$URL/" 2>&1 | head -1
}
denied() { case "$1" in *ACCESS_DENIED*|*"Not enough privileges"*) return 0;; *) return 1;; esac; }

cleanup() {
  [ "${KEEP:-0}" = "1" ] && { echo "KEEP=1: members and rooms left in place; homes in $WORK"; return; }
  [ "${CREATED:-0}" = "1" ] || return 0
  for p in $PEOPLE; do
    admin_q "DROP USER IF EXISTS $p" >/dev/null 2>&1 || true
    for t in $(admin_q "SELECT name FROM system.tables WHERE database = 'mem' AND startsWith(name, '${p}_') FORMAT TSV" 2>/dev/null); do
      admin_q "DROP TABLE IF EXISTS mem.$t SYNC" >/dev/null 2>&1 || true
    done
  done
  rm -rf "$WORK"
  echo "removed alice, bob, carol, their rooms and their homes"
}
trap cleanup EXIT

existing=$(admin_q "SELECT count() FROM system.users WHERE name IN ('alice','bob','carol') FORMAT TSV")
[ "$existing" = "0" ] || { echo "refusing: users alice/bob/carol already exist on this server — use a throwaway ClickHouse"; exit 1; }
CREATED=1

# A loopback URL is right only through a tunnel; invite refuses one unless told so.
case "$URL" in http://localhost*|http://127.0.0.1*|https://localhost*|https://127.0.0.1*) LOCAL=--allow-local;; *) LOCAL=;; esac

echo "== 1. the admin invites three members"
# The admin needs no install of their own: an empty home, so nothing stored is read.
export MEMHOUSE_HOME="$WORK/admin"; mkdir -p "$MEMHOUSE_HOME"
for p in $PEOPLE; do
  # One env file per person. It IS a password: hand it over through a trusted channel.
  out=$(cd "$WORK" && mh invite "$p" --url "$URL" --admin-user "$MEMHOUSE_ADMIN_USER" --out "$WORK/$p.env" $LOCAL 2>&1) \
    || { printf '%s\n' "$out"; exit 1; }
  printf '%s\n' "$out" | grep "invite written"
done

echo
echo "== 2. each member installs from their file, on their own machine (here: their own home)"
for p in $PEOPLE; do
  export MEMHOUSE_HOME="$WORK/$p"; mkdir -p "$MEMHOUSE_HOME"
  node "$HERE/../fixtures/make-sessions.js" "$MEMHOUSE_HOME/sessions" "$p" alpha beta >/dev/null
  # --yes also rotates the invited password to one only this home knows, and deletes the file.
  out=$(unset MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD
        mh install --env "$WORK/$p.env" --editors claude --claude-roots "$MEMHOUSE_HOME/sessions" --yes --no-ship 2>&1) \
    || { printf '%s\n' "$out"; exit 1; }
  printf '%s\n' "$out" | grep -E "installed$|rotat|removed the spent" | sed "s/^/  $p: /" || true
  (unset MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD; mh ship) | sed "s/^/  $p: /"
done
unset MEMHOUSE_HOME

echo
echo "== 3. alice shares: everything with bob, project alpha only with carol"
export MEMHOUSE_HOME="$WORK/alice"
mh share bob --yes
mh share carol --only project=alpha --yes
mh share --list

echo
echo "== 4. who reads what — each with their own credential"
show() { printf '  %-44s %s\n' "$1" "$2"; }
show "alice, her own messages by project"   "$(as alice "SELECT arrayStringConcat(arraySort(groupUniqArray(project)), ',') || ' ' || toString(count()) FROM mem.alice_messages FORMAT TSV")"
show "bob (full share), alice's messages"   "$(as bob   "SELECT arrayStringConcat(arraySort(groupUniqArray(project)), ',') || ' ' || toString(count()) FROM mem.alice_messages FORMAT TSV")"
show "carol (alpha only), alice's messages" "$(as carol "SELECT arrayStringConcat(arraySort(groupUniqArray(project)), ',') || ' ' || toString(count()) FROM mem.alice_messages FORMAT TSV")"
r=$(as bob "SELECT count() FROM mem.alice_session_stats FORMAT TSV");   show "bob, alice's session_stats"   "$(denied "$r" && echo denied || echo "$r rows")"
r=$(as carol "SELECT count() FROM mem.alice_session_stats FORMAT TSV"); show "carol, alice's session_stats" "$(denied "$r" && echo denied || echo "$r rows")"
r=$(as carol "SELECT count() FROM mem.alice_meta FORMAT TSV");          show "carol, alice's meta"          "$(denied "$r" && echo denied || echo "$r rows")"
r=$(as carol "SELECT count() FROM mem.bob_messages FORMAT TSV");        show "carol, bob's messages (never shared)" "$(denied "$r" && echo denied || echo "$r rows")"

echo
echo "== 5. alice withdraws both shares"
mh share bob --revoke --yes
mh share carol --revoke --yes
r=$(as bob "SELECT count() FROM mem.alice_messages FORMAT TSV");   show "bob, alice's messages"   "$(denied "$r" && echo denied || echo "$r rows")"
r=$(as carol "SELECT count() FROM mem.alice_messages FORMAT TSV"); show "carol, alice's messages" "$(denied "$r" && echo denied || echo "$r rows")"
unset MEMHOUSE_HOME
