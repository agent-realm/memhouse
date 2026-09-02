#!/bin/sh
# End-to-end: one shared database, two members, per-table grants.
URL=${1:?url}; ADM=${2:?admin}; APW=${3:?password}
CLI="node $(cd "$(dirname "$0")/.." && pwd)/bin/memhouse.js"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
unset MEMHOUSE_URL MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB MEMHOUSE_TABLE_PREFIX MEMHOUSE_HOME

pass=0; fail=0
ok(){ printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
A(){ curl -sS -u "$ADM:$APW" --data-binary "$1" "$URL/"; }
M(){ u=$1; pw=$2; shift 2; curl -sS -u "$u:$pw" --data-binary "$1" "$URL/" 2>&1 | head -1; }

A "DROP DATABASE IF EXISTS mem SYNC" >/dev/null
for u in alice bob; do A "DROP USER IF EXISTS $u" >/dev/null; done
A "CREATE DATABASE mem" >/dev/null

echo "=== provision two members into ONE database ==="
for u in alice bob; do
  out=$(cd "$WORK" && $CLI invite "$u" --url "$URL" --shared-db mem \
        --admin-user "$ADM" --admin-password "$APW" --allow-local --out "$WORK/$u.env" 2>&1)
  printf '%s' "$out" | grep -q "invite written" && ok "invited $u" || bad "invite $u" "$(printf '%s' "$out" | tail -2)"
  printf '%s' "$out" | grep -q "rooms as mem.${u}_\*" && ok "  created mem.${u}_* rooms" || bad "  rooms for $u" "$(printf '%s' "$out" | grep -i room | head -1)"
done

echo
echo "=== the invite file carries the prefix ==="
grep -q "MEMHOUSE_TABLE_PREFIX='alice'" "$WORK/alice.env" && ok "alice.env has the prefix" || bad "alice.env prefix missing"
grep -q "MEMHOUSE_DB='mem'" "$WORK/alice.env" && ok "alice.env points at the shared db" || bad "alice.env db wrong"

echo
echo "=== tables actually created ==="
tbl=$(A "SELECT name FROM system.tables WHERE database='mem' ORDER BY name FORMAT TSV" | tr '\n' ' ')
echo "    mem holds: $tbl"
for t in alice_messages alice_sessions alice_tool_calls bob_messages bob_sessions bob_tool_calls; do
  printf '%s' "$tbl" | grep -q "$t" || bad "missing table $t"
done
printf '%s' "$tbl" | grep -q "alice_messages" && printf '%s' "$tbl" | grep -q "bob_messages" && ok "both members' rooms exist"

echo
echo "=== ISOLATION — the whole point ==="
APW_A=$(grep -o "MEMHOUSE_PASSWORD='[^']*'" "$WORK/alice.env" | sed "s/.*='//;s/'//")
APW_B=$(grep -o "MEMHOUSE_PASSWORD='[^']*'" "$WORK/bob.env" | sed "s/.*='//;s/'//")
r=$(M alice "$APW_A" "SELECT count() FROM mem.alice_messages")
case "$r" in ''|*[!0-9]*) bad "alice cannot read her own room" "$r";; *) ok "alice reads her own room ($r)";; esac
r=$(M alice "$APW_A" "SELECT count() FROM mem.bob_messages")
printf '%s' "$r" | grep -q "ACCESS_DENIED" && ok "alice CANNOT read bob's room" || bad "LEAK: alice read bob's room" "$r"
r=$(M alice "$APW_A" "SHOW TABLES FROM mem" | tr '\n' ' ')
printf '%s' "$r" | grep -q "bob" && bad "alice can SEE bob's tables listed" "$r" || ok "alice cannot even list bob's rooms"
r=$(M alice "$APW_A" "CREATE TABLE mem.sneaky (x UInt8) ENGINE=MergeTree ORDER BY x")
printf '%s' "$r" | grep -q "ACCESS_DENIED" && ok "alice cannot create tables in the shared db" || bad "alice created a table in mem" "$r"
r=$(M alice "$APW_A" "DROP TABLE mem.bob_messages")
printf '%s' "$r" | grep -q "ACCESS_DENIED" && ok "alice cannot drop bob's room" || bad "alice dropped bob's room" "$r"

echo
echo "=== the member's own tooling works against a prefixed house ==="
export MEMHOUSE_HOME="$WORK/alicehome"; mkdir -p "$MEMHOUSE_HOME"
cp "$WORK/alice.env" "$MEMHOUSE_HOME/env"
out=$($CLI whoami --json 2>&1)
printf '%s' "$out" | grep -q '"role"' && ok "whoami works" || bad "whoami" "$(printf '%s' "$out" | head -2)"
out=$($CLI status 2>&1)
printf '%s' "$out" | grep -q "rooms for" && ok "status resolves the prefixed rooms" || bad "status" "$(printf '%s' "$out" | head -3)"
out=$($CLI ship --ensure-schema 2>&1)
printf '%s' "$out" | grep -qi "error\|denied" && bad "ensure-schema errored" "$(printf '%s' "$out" | head -2)" || ok "ensure-schema survives without CREATE rights"

echo
echo "=== writes land in the member's own room, and nowhere else ==="
A "INSERT INTO mem.alice_messages (session_id, seq, source, host, ts, role, text, line_hash) VALUES ('s',0,'x','h',now(),'user','hi',1)" >/dev/null 2>&1
a=$(A "SELECT count() FROM mem.alice_messages" | tr -d '\n'); b=$(A "SELECT count() FROM mem.bob_messages" | tr -d '\n')
[ "$a" -ge 1 ] && [ "$b" = "0" ] && ok "a write to alice's room left bob's at 0 (alice=$a bob=$b)" || bad "cross-room write" "alice=$a bob=$b"

echo
echo "=== sharing inside a shared database ==="
export MEMHOUSE_HOME="$WORK/alicehome"
out=$($CLI share bob 2>&1)
printf '%s' "$out" | grep -q "can now read" && ok "alice can share her rooms without an operator" || bad "share failed" "$(printf '%s' "$out" | head -2)"
printf '%s' "$out" | grep -q "alice_\*" && ok "  the message names her rooms, not the database" || bad "  share message claims the whole database" "$(printf '%s' "$out" | head -1)"
r=$(M bob "$APW_B" "SELECT count() FROM mem.alice_messages")
case "$r" in ''|*[!0-9]*) bad "bob cannot read what was shared" "$r";; *) ok "bob reads alice's shared room ($r)";; esac
A "CREATE TABLE IF NOT EXISTS mem.carl_messages (x UInt8) ENGINE=MergeTree ORDER BY x" >/dev/null
r=$(M bob "$APW_B" "SELECT count() FROM mem.carl_messages")
printf '%s' "$r" | grep -q "ACCESS_DENIED" && ok "bob still cannot reach an unshared room" || bad "LEAK: share reached a third member" "$r"
out=$($CLI share bob --revoke 2>&1)
printf '%s' "$out" | grep -q "revoked" && ok "revoke works" || bad "revoke" "$(printf '%s' "$out" | head -1)"
r=$(M bob "$APW_B" "SELECT count() FROM mem.alice_messages")
printf '%s' "$r" | grep -q "ACCESS_DENIED" && ok "bob loses access after revoke" || bad "revoke did not bite" "$r"

echo
echo "=== the metadata plane — it used to fail SILENTLY in a prefixed house ==="
# Every meta read and write in the CLI spelled `house_meta`/`house_events` by hand and
# swallowed the error, so a prefixed house had no ledger, no schema version, and a
# `share --list` that said "nobody has been granted a read" while a grant was live.
export MEMHOUSE_HOME="$WORK/alicehome"
r=$(A "SELECT count() FROM mem.alice_house_meta" | tr -d '\n')
case "$r" in ''|*[!0-9]*) bad "alice_house_meta is not readable" "$r";; *) ok "the member's own meta room exists ($r rows)";; esac
$CLI share bob --yes >/dev/null 2>&1
out=$($CLI share --list 2>&1)
printf '%s' "$out" | grep -q "bob" && ok "share --list reports a live share" || bad "share --list lost a real share" "$(printf '%s' "$out" | head -2)"
printf '%s' "$out" | grep -q "your rooms in" && ok "  and says ROOMS, not the whole database" || bad "  share --list still names the database"
$CLI share bob --revoke --yes >/dev/null 2>&1

echo
echo "=== SCOPED sharing: asking for one project must not hand over all of them ==="
# The worst failure this command had. `share <user> --only project=x` granted SELECT
# first and built the row-policy filters second; in a shared house the member had no
# CREATE ROW POLICY right at all, so the grant always landed and the scoping always
# failed — a member asking to share ONE project gave away EVERY one, and share --list
# then reported "nobody has been granted". Found in a drill.
A "INSERT INTO mem.alice_messages (session_id, seq, source, host, ts, role, text, line_hash, project) VALUES ('sa',7,'x','h',now(),'user','scoped alpha',77,'alpha'),('sb',8,'x','h',now(),'user','scoped beta',78,'beta')" >/dev/null 2>&1
export MEMHOUSE_HOME="$WORK/alicehome"
out=$($CLI share bob --only project=alpha --yes 2>&1)
printf '%s' "$out" | grep -q "✓" && ok "a member can scope a share to one project" || bad "scoped share failed" "$(printf '%s' "$out" | grep '✗' | head -1)"
r=$(M bob "$APW_B" "SELECT groupUniqArray(project) FROM mem.alice_messages FORMAT TSV")
printf '%s' "$r" | grep -q "beta" && bad "LEAK: a --only share exposed another project" "$r" || ok "  the grantee sees only the named project"
$CLI share bob --revoke --yes >/dev/null 2>&1

# And when scoping CANNOT be done, nothing may be granted at all.
A "REVOKE CREATE ROW POLICY ON mem.alice_sessions FROM alice" >/dev/null 2>&1
out=$($CLI share bob --only project=alpha --yes 2>&1)
printf '%s' "$out" | grep -q "NOTHING WAS GRANTED" && ok "a scoping failure grants nothing" || bad "a scoping failure did not say it granted nothing" "$(printf '%s' "$out" | tail -2)"
r=$(M bob "$APW_B" "SELECT count() FROM mem.alice_messages")
printf '%s' "$r" | grep -q "ACCESS_DENIED\|Not enough privileges" && ok "  and the grantee really has no access" || bad "  LEAK: grantee has access after a failed scoped share" "$r"
n=$(A "SELECT count() FROM system.row_policies WHERE database='mem' AND short_name LIKE '%bob%' FORMAT TSV" | tr -d '\n')
[ "$n" = "0" ] && ok "  and no half-built filters were left behind" || bad "  $n orphaned row polic(y/ies) left"
A "GRANT CREATE ROW POLICY ON mem.alice_sessions TO alice" >/dev/null 2>&1

echo
echo "=== cleanup ==="
A "DROP DATABASE IF EXISTS mem SYNC" >/dev/null
for u in alice bob; do A "DROP USER IF EXISTS $u" >/dev/null; done
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
