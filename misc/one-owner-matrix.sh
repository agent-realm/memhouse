#!/bin/sh
# The one-owner invariant: a database is ONE member's house, or a shared house of
# per-member rooms. Never both, never two database-wide owners.
#
# This exists because the mixed shape was documented as the way to run a team, and it
# leaks: a member holding ALL ON db.* WITH GRANT OPTION can read every housemate's rows
# and grant them to an outsider — no admin, no notification. The last two cases here are
# that leak, run against a real server, proving the shape is now unreachable rather than
# merely discouraged.
URL=${1:?url}; ADM=${2:?admin}; APW=${3:?password}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="node $ROOT/bin/memhouse.js"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
unset MEMHOUSE_URL MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB MEMHOUSE_TABLE_PREFIX MEMHOUSE_HOME

pass=0; fail=0
ok(){ printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
A(){ curl -sS -u "$ADM:$APW" --data-binary "$1" "$URL/"; }
inv(){ (cd "$WORK" && $CLI invite "$@" --url "$URL" --admin-user "$ADM" --admin-password "$APW" --allow-local 2>&1); }

reset_all(){
  for d in alice bob team mem; do A "DROP DATABASE IF EXISTS $d SYNC" >/dev/null; done
  for u in alice bob carol; do A "DROP USER IF EXISTS $u" >/dev/null; done
}
reset_all

echo "=== a house of one still works (the common case must not regress) ==="
out=$(inv alice --out "$WORK/alice.env")
printf '%s' "$out" | grep -q "invite written" && ok "alice got a house of her own" || bad "invite alice" "$(printf '%s' "$out" | tail -2)"

echo
echo "=== a SECOND member cannot be put in that house ==="
out=$(inv bob --db alice --out "$WORK/bob.env")
printf '%s' "$out" | grep -q "cannot join house" && ok "refused bob into alice's house" || bad "bob was allowed into alice's house" "$(printf '%s' "$out" | tail -3)"
printf '%s' "$out" | grep -q "alice" && ok "  the refusal names the existing owner" || bad "  refusal did not say whose house it is"
printf '%s' "$out" | grep -q -- "--shared-db" && ok "  and points at rooms-per-member" || bad "  no route offered"
[ -f "$WORK/bob.env" ] && bad "  an env file was written for a refused invite" || ok "  nothing was written"
n=$(A "SELECT count() FROM system.grants WHERE database='alice' AND user_name='bob' FORMAT TSV" | tr -d '\n')
[ "$n" = "0" ] && ok "  bob holds no grant on alice's house" || bad "  bob was granted anyway ($n)"

echo
echo "=== --adopt must NOT re-open the door ==="
# --adopt is a takeover of one's own house, not a way to add a second member.
A "INSERT INTO alice.messages (session_id, seq, source, host, ts, role, text, line_hash) VALUES ('s',0,'x','h',now(),'user','alice memory',1)" >/dev/null 2>&1
out=$(inv bob --db alice --adopt --out "$WORK/bob2.env")
printf '%s' "$out" | grep -q "cannot join house" && ok "--adopt does not defeat the invariant" || bad "LEAK: --adopt put bob in alice's house" "$(printf '%s' "$out" | tail -3)"

echo
echo "=== rooms-per-member: many members, one database, no owner ==="
A "CREATE DATABASE mem" >/dev/null
for u in alice bob; do A "DROP USER IF EXISTS $u" >/dev/null; done
A "DROP DATABASE IF EXISTS alice SYNC" >/dev/null
for u in alice bob; do
  out=$(inv "$u" --shared-db mem --out "$WORK/$u.mem.env")
  printf '%s' "$out" | grep -q "invite written" && ok "$u got rooms in the shared house" || bad "invite $u --shared-db" "$(printf '%s' "$out" | tail -2)"
done
n=$(A "SELECT count() FROM system.grants WHERE database='mem' AND table IS NULL AND user_name IS NOT NULL FORMAT TSV" | tr -d '\n')
[ "$n" = "0" ] && ok "nobody holds a database-wide grant on the shared house" || bad "a database-wide grant exists in a shared house ($n)"

echo
echo "=== THE LEAK, attempted for real ==="
# alice tries to hand a stranger 'SELECT ON mem.*'. In the old shape this succeeded and
# carried bob's rows with it.
PW_A=$(grep -o "MEMHOUSE_PASSWORD='[^']*'" "$WORK/alice.mem.env" | sed "s/.*='//;s/'//")
A "CREATE USER carol IDENTIFIED WITH plaintext_password BY 'x'" >/dev/null
A "INSERT INTO mem.bob_messages (session_id, seq, source, host, ts, role, text, line_hash) VALUES ('b',0,'x','h',now(),'user','bob secret',2)" >/dev/null 2>&1
r=$(curl -sS -u "alice:$PW_A" --data-binary "GRANT SELECT ON mem.* TO carol" "$URL/" 2>&1 | head -1)
printf '%s' "$r" | grep -q "ACCESS_DENIED\|Not enough privileges" && ok "alice CANNOT grant the whole database away" || bad "LEAK: alice granted mem.* to an outsider" "$r"
r=$(curl -sS -u carol:x --data-binary "SELECT count() FROM mem.bob_messages" "$URL/" 2>&1 | head -1)
printf '%s' "$r" | grep -q "ACCESS_DENIED\|Not enough privileges" && ok "carol cannot read bob's room" || bad "LEAK: carol read bob's room" "$r"

echo
echo "=== but alice can still share what IS hers ==="
r=$(curl -sS -u "alice:$PW_A" --data-binary "GRANT SELECT ON mem.alice_messages TO carol" "$URL/" 2>&1 | head -1)
[ -z "$r" ] && ok "alice shares her own room without an operator" || bad "alice could not share her own room" "$r"
r=$(curl -sS -u carol:x --data-binary "SELECT count() FROM mem.alice_messages FORMAT TSV" "$URL/" 2>&1 | head -1)
case "$r" in ''|*[!0-9]*) bad "carol cannot read the room alice shared" "$r";; *) ok "carol reads alice's shared room";; esac

echo
echo "=== cleanup ==="
reset_all
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
