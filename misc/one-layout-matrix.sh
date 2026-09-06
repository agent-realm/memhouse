#!/bin/sh
# ONE layout, proved against a real ClickHouse.
#
# Every member holds one grant — on <db>.<name>_* — and nothing else in the house. That
# single statement is the access model: the member builds their own rooms under it, shares
# under it, and a colleague reads it back with SHOW GRANTS in one line. This matrix is the
# proof that the statement does what the design says, from every seat: the operator who
# provisions, the member who ships, the housemate who must not see, the grantee who may.
#
# Grants must be proved live. A missing grant and a working one look identical until
# somebody reads a table they should not — which is the last case here, attempted for real.
URL=${1:?url}; ADM=${2:?admin}; APW=${3:?password}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="node $ROOT/bin/memhouse.js"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# Never read this machine's real ~/.memhouse — a test once took its database name from it.
export MEMHOUSE_HOME="$WORK/nohome"; mkdir -p "$MEMHOUSE_HOME"
unset MEMHOUSE_URL MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD

pass=0; fail=0
ok(){ printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
A(){ curl -sS -u "$ADM:$APW" --data-binary "$1" "$URL/" 2>&1; }
M(){ curl -sS -u "$1:$2" --data-binary "$3" "$URL/" 2>&1 | head -1; }
inv(){ (cd "$WORK" && $CLI invite "$@" --url "$URL" --admin-user "$ADM" --admin-password "$APW" --allow-local 2>&1); }
denied(){ printf '%s' "$1" | grep -q "ACCESS_DENIED\|Not enough privileges"; }
pwof(){ grep -o "MEMHOUSE_PASSWORD='[^']*'" "$1" | sed "s/.*='//;s/'//"; }

A "DROP DATABASE IF EXISTS mem SYNC" >/dev/null
for u in alice bob psql; do A "DROP USER IF EXISTS $u" >/dev/null; done

echo "=== provisioning: one grant, on the member's pattern ==="
out=$(inv alice --out "$WORK/alice.env")
printf '%s' "$out" | grep -q "invite written" && ok "alice invited into the default house" || bad "invite alice" "$(printf '%s' "$out" | tail -3)"
grep -q "MEMHOUSE_DB='mem'" "$WORK/alice.env" && ok "  the house is 'mem' — nothing was chosen" || bad "  db is not mem" "$(grep MEMHOUSE_DB "$WORK/alice.env")"
grep -q "TABLE_PREFIX" "$WORK/alice.env" && bad "  the invite file still carries a prefix field" || ok "  the invite file carries no layout knob"
[ -f "$WORK/MEMHOUSE-INVITATION.md" ] && ok "  the invitation guide was written beside it" || bad "  no MEMHOUSE-INVITATION.md beside the env file"
grep -q "alice_messages" "$WORK/MEMHOUSE-INVITATION.md" 2>/dev/null && ok "  and names her rooms" || bad "  the guide does not name her rooms"
grep -q "$(grep -o "MEMHOUSE_PASSWORD='[^']*'" "$WORK/alice.env" | sed "s/.*='//;s/'//")" "$WORK/MEMHOUSE-INVITATION.md" 2>/dev/null && bad "  LEAK: the password is in the guide" || ok "  and carries no secret"
grep -q "{{" "$WORK/MEMHOUSE-INVITATION.md" 2>/dev/null && bad "  unrendered placeholder in the guide" || ok "  every placeholder rendered"
out=$(inv bob --member-password bpw --out "$WORK/bob.env")
printf '%s' "$out" | grep -q "invite written" && ok "bob invited beside her" || bad "invite bob" "$(printf '%s' "$out" | tail -2)"
n=$(A "SELECT count() FROM system.grants WHERE user_name='alice' AND database='mem' AND table IS NULL FORMAT TSV" | tr -d '\n')
[ "$n" = "0" ] && ok "alice holds nothing database-wide" || bad "alice holds a database-wide grant ($n rows)"
n=$(A "SELECT count() FROM system.grants WHERE user_name='alice' AND database='mem' AND is_wildcard = 0 FORMAT TSV" | tr -d '\n')
[ "$n" = "0" ] && ok "  and no per-table grants — the pattern is the whole grant" || bad "  per-table grants present ($n)"
pat=$(A "SELECT DISTINCT table FROM system.grants WHERE user_name='alice' AND database='mem' AND is_wildcard = 1 FORMAT TSV" | tr -d '\n')
[ "$pat" = "alice_" ] && ok "  the pattern is alice_*" || bad "  unexpected pattern '$pat'"
A "SHOW GRANTS FOR alice FORMAT TSV" | grep -q "ON mem.alice_\* TO alice WITH GRANT OPTION" && ok "  SHOW GRANTS says so in one line — what a colleague verifies" || bad "  SHOW GRANTS does not show the pattern" "$(A "SHOW GRANTS FOR alice FORMAT TSV" | head -2)"

echo
echo "=== the member builds her own rooms ==="
export MEMHOUSE_HOME="$WORK/alicehome"; mkdir -p "$MEMHOUSE_HOME"
out=$($CLI install --env "$WORK/alice.env" --yes --no-ship 2>&1)
printf '%s' "$out" | grep -q "installed" && ok "alice installed from the invite file" || bad "install --env" "$(printf '%s' "$out" | grep '✗' | head -2)"
APW_A=$(pwof "$MEMHOUSE_HOME/env")
out=$($CLI ship --ensure-schema 2>&1)
printf '%s' "$out" | grep -qi "needed rights" && bad "ensure-schema hit a privilege wall — the member should hold CREATE TABLE on her pattern" "$(printf '%s' "$out" | head -2)" || ok "ensure-schema created her rooms with her own credential"
tbl=$(A "SELECT arrayStringConcat(arraySort(groupArray(name)), ' ') FROM system.tables WHERE database='mem' AND name LIKE 'alice%' FORMAT TSV" | tr -d '\n')
[ "$tbl" = "alice_events alice_messages alice_meta alice_sessions alice_tool_calls" ] && ok "  all five rooms exist, named for her" || bad "  rooms: $tbl"
out=$($CLI rooms --json 2>&1)
printf '%s' "$out" | grep -q '"pattern": "alice_\*"' && ok "memhouse rooms names the pattern" || bad "rooms --json" "$(printf '%s' "$out" | head -3)"

echo
echo "=== isolation, from the member's seat ==="
A "CREATE TABLE IF NOT EXISTS mem.bob_messages (session_id String, seq UInt32, text String, project String, user_id String MATERIALIZED currentUser()) ENGINE=ReplacingMergeTree ORDER BY (session_id, seq)" >/dev/null
A "INSERT INTO mem.bob_messages (session_id, seq, text, project) VALUES ('b', 0, 'bob secret', 'x')" >/dev/null
r=$(M alice "$APW_A" "SELECT count() FROM mem.alice_messages FORMAT TSV"); case "$r" in ''|*[!0-9]*) bad "alice cannot read her own room" "$r";; *) ok "alice reads her own room";; esac
denied "$(M alice "$APW_A" "SELECT count() FROM mem.bob_messages")" && ok "alice cannot read bob's" || bad "LEAK: alice read bob's room"
r=$(M alice "$APW_A" "SELECT groupArray(name) FROM (SELECT name FROM system.tables WHERE database='mem' ORDER BY name) FORMAT TSV")
printf '%s' "$r" | grep -q "bob" && bad "alice can LIST bob's rooms" "$r" || ok "alice cannot even list bob's rooms"
denied "$(M alice "$APW_A" "CREATE TABLE mem.sneaky (x UInt8) ENGINE=MergeTree ORDER BY x")" && ok "alice cannot create a table outside her pattern" || bad "alice created mem.sneaky"
r=$(M alice "$APW_A" "CREATE TABLE mem.alice_scratch (x UInt8) ENGINE=MergeTree ORDER BY x"); [ -z "$r" ] && ok "  but can create inside it (a rebuild needs this)" || bad "  cannot create inside her own pattern" "$r"
r=$(M alice "$APW_A" "DROP TABLE mem.alice_scratch"); [ -z "$r" ] && ok "  and drop inside it" || bad "  cannot drop inside her own pattern" "$r"
denied "$(M alice "$APW_A" "DROP TABLE mem.bob_messages")" && ok "alice cannot drop bob's" || bad "LEAK: alice dropped bob's room"
denied "$(M alice "$APW_A" "GRANT SELECT ON mem.bob_* TO alice")" && ok "alice cannot grant herself bob's pattern" || bad "LEAK: alice re-granted bob's pattern"
denied "$(M alice "$APW_A" "GRANT SELECT ON mem.* TO bob")" && ok "alice cannot grant the database away" || bad "LEAK: alice granted mem.*"

echo
echo "=== sharing: one grant, one level down ==="
A "INSERT INTO mem.alice_messages (session_id, seq, source, host, ts, role, text, line_hash, project) VALUES ('s1',0,'x','h',now(),'user','alpha secret',1,'alpha'),('s2',0,'x','h',now(),'user','beta secret',2,'beta')" >/dev/null 2>&1
out=$($CLI share bob --yes 2>&1)
printf '%s' "$out" | grep -q "✓" && ok "alice shares her rooms with bob, no operator" || bad "share bob" "$(printf '%s' "$out" | grep '✗')"
r=$(M bob bpw "SELECT count() FROM mem.alice_messages FORMAT TSV"); case "$r" in ''|*[!0-9]*) bad "bob cannot read the shared rooms" "$r";; *) ok "  bob reads alice's rooms ($r)";; esac
$CLI share --list 2>&1 | grep -q "bob" && ok "  share --list shows bob" || bad "  share --list lost the share"
$CLI share --list --json 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.grantees.some(g=>g.user==='bob')&&j.rooms==='alice_*'?0:1)})" && ok "  and --json carries the pattern and the grantee" || bad "  share --list --json wrong"
$CLI share bob --revoke --yes >/dev/null 2>&1
denied "$(M bob bpw "SELECT count() FROM mem.alice_messages")" && ok "  revoke works — bob is denied again" || bad "  bob still reads after revoke"
out=$($CLI share bob --only project=alpha --yes 2>&1)
printf '%s' "$out" | grep -q "✓" && ok "a scoped share works from the member's own grant" || bad "scoped share failed" "$(printf '%s' "$out" | grep '✗' | head -1)"
r=$(M bob bpw "SELECT groupUniqArray(project) FROM mem.alice_messages FORMAT TSV")
printf '%s' "$r" | grep -q beta && bad "LEAK: scoped share exposed another project" "$r" || ok "  bob sees only the named project"
$CLI share bob --revoke --yes >/dev/null 2>&1
A "REVOKE CREATE ROW POLICY ON mem.alice_* FROM alice" >/dev/null
out=$($CLI share bob --only project=alpha --yes 2>&1)
printf '%s' "$out" | grep -q "NOTHING WAS GRANTED" && ok "a scoping failure grants nothing" || bad "scoping failure did not say it granted nothing" "$(printf '%s' "$out" | tail -2)"
denied "$(M bob bpw "SELECT count() FROM mem.alice_messages")" && ok "  and bob really has nothing" || bad "  LEAK after a failed scoped share"
A "GRANT CREATE ROW POLICY ON mem.alice_* TO alice WITH GRANT OPTION" >/dev/null

echo
echo "=== the printed plan is the executed plan ==="
out=$(cd "$WORK" && $CLI invite psql --url "$URL" --allow-local --admin-user "$ADM" --admin-password "$APW" --member-password 'x' --print-sql 2>&1)
printf '%s' "$out" | grep -qE "GRANT .* ON mem\.\* " && bad "LEAK: --print-sql emits a database-wide grant" || ok "no database-wide grant in the printed plan"
printf '%s' "$out" | grep -qE "^GRANT .* ON mem\.psql_\* TO psql WITH GRANT OPTION;" && ok "  one grant on psql_*" || bad "  the pattern grant is missing" "$(printf '%s' "$out" | grep -m1 '^GRANT')"
printf '%s' "$out" | grep -q "^CREATE TABLE" && bad "  the plan pre-builds rooms — the member's shipper does that" || ok "  no DDL — the member builds their own rooms"
printf '%s' "$out" | grep -v '^--' | grep -v '^$' | while IFS= read -r st; do
  st=$(printf '%s' "$st" | sed 's/;[[:space:]]*$//'); [ -n "$st" ] && A "$st" >/dev/null
done
r=$(M psql x "CREATE TABLE mem.psql_messages (x UInt8) ENGINE=MergeTree ORDER BY x"); [ -z "$r" ] && ok "  a DBA-provisioned member builds their own rooms" || bad "  DBA-provisioned member cannot create their rooms" "$r"
denied "$(M psql x "SELECT count() FROM mem.alice_messages")" && ok "  and isolates exactly like the live path" || bad "  LEAK: DBA-provisioned member reads a housemate"

echo
echo "=== re-inviting a name whose rooms hold messages ==="
out=$(inv alice --out "$WORK/alice2.env")
printf '%s' "$out" | grep -q "already exists and holds" && ok "refused: alice's rooms already hold messages" || bad "re-invite was not refused" "$(printf '%s' "$out" | tail -2)"
out=$(inv alice --adopt --member-password "$APW_A" --out "$WORK/alice3.env")
printf '%s' "$out" | grep -q "adopting" && ok "--adopt takes them over (same person, new credential)" || bad "--adopt failed" "$(printf '%s' "$out" | grep '✗' | head -1)"

echo
echo "=== who is in the house ==="
out=$($CLI members --admin-user "$ADM" --admin-password "$APW" 2>&1)
printf '%s' "$out" | grep -q "alice_\*" && printf '%s' "$out" | grep -q "bob_\*" && ok "members lists each pattern" || bad "members" "$(printf '%s' "$out" | head -4)"
printf '%s' "$out" | grep -q "WHOLE database" && bad "  members warns about an owner — nobody should own the house" || ok "  and nobody holds the whole database"

echo
echo "=== cleanup ==="
A "DROP DATABASE IF EXISTS mem SYNC" >/dev/null
for u in alice bob psql; do A "DROP USER IF EXISTS $u" >/dev/null; done
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
