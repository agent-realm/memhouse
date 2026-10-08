#!/bin/sh
# Does the connection recipe in reference/HOUSE.md actually work in BOTH layouts?
#
# The skills do not resolve room names themselves — they write `FROM messages` and rely on
# the `q()` in HOUSE.md to supply a prefix when there is one. That makes q() load-bearing
# for every /mem:* skill, so it is extracted from the doc VERBATIM here rather than
# retyped: a test of a paraphrase of the recipe proves nothing about the recipe.
URL=${1:?url}; ADM=${2:?admin}; APW=${3:?password}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DOC="$ROOT/memhouse/delivery/plugin/reference/HOUSE.md"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# Never read this machine's real ~/.memhouse — a test once took its database name from it.
export MEMHOUSE_HOME="$WORK/nohome"; mkdir -p "$MEMHOUSE_HOME"

pass=0; fail=0
ok(){ printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
A(){ curl -sS -u "$ADM:$APW" --data-binary "$1" "$URL/"; }

# Pull the q() definition straight out of the reference.
awk '/^q\(\) \{/,/^\}/' "$DOC" > "$WORK/q.sh"
[ -s "$WORK/q.sh" ] && ok "extracted q() from HOUSE.md" || { bad "could not extract q() — did the doc change?"; exit 1; }
grep -q 'sed -E' "$WORK/q.sh" && ok "  the extracted q() carries the name rewrite" || bad "  q() has no rewrite step"

echo
echo "=== a prefixed house, read through the documented recipe ==="
A "DROP DATABASE IF EXISTS mem SYNC" >/dev/null; A "DROP USER IF EXISTS carol" >/dev/null
A "CREATE DATABASE mem" >/dev/null
(cd "$WORK" && node "$ROOT/bin/memhouse.js" invite carol --url "$URL" --db mem \
   --admin-user "$ADM" --admin-password "$APW" --allow-local --out "$WORK/carol.env" >/dev/null 2>&1)
A "INSERT INTO mem.carol_messages (session_id, seq, source, host, ts, role, text, line_hash) VALUES ('s',0,'x','h',now(),'user','the needle',1)" >/dev/null 2>&1

run_recipe() {  # $1 = env file, $2 = SQL — mirrors what a skill does
  ( set -a; . "$1"; set +a; . "$WORK/q.sh"; printf '%s\n' "$2" | q ) 2>&1
}

r=$(run_recipe "$WORK/carol.env" "SELECT count() FROM messages FORMAT TSV")
case "$r" in ''|*[!0-9]*) bad "bare 'FROM messages' did not resolve" "$r";;
             *) ok "a skill's bare 'FROM messages' reached carol_messages ($r row)";; esac

# The trap the rewrite must not fall into: a needle that contains a room name.
r=$(run_recipe "$WORK/carol.env" "SELECT count() FROM messages WHERE text LIKE '%messages%' FORMAT TSV")
[ "$r" = "0" ] && ok "a literal '%messages%' in the needle was left alone" || bad "needle corrupted by the rewrite" "$r"

# Subquery form — the epoch filter every analytic query carries.
r=$(run_recipe "$WORK/carol.env" "SELECT count() FROM messages WHERE (session_id, user_id, epoch) IN (SELECT session_id, user_id, max(epoch) FROM messages GROUP BY session_id, user_id) FORMAT TSV")
case "$r" in ''|*[!0-9]*) bad "the epoch subquery did not resolve" "$r";;
             *) ok "the epoch subquery's inner FROM was rewritten too ($r)";; esac

r=$(run_recipe "$WORK/carol.env" "SELECT count() FROM sessions FORMAT TSV")
case "$r" in ''|*[!0-9]*) bad "FROM sessions did not resolve" "$r";; *) ok "FROM sessions resolved";; esac

echo
echo "=== the rooms verb agrees with the server ==="
out=$(cd "$WORK" && MEMHOUSE_HOME="$WORK/ch" sh -c 'mkdir -p "$MEMHOUSE_HOME" && cp '"$WORK"'/carol.env "$MEMHOUSE_HOME/env" && node '"$ROOT"'/bin/memhouse.js rooms --json' 2>&1)
printf '%s' "$out" | grep -qF '"pattern": "carol_*"' && ok "rooms reports the member pattern" || bad "rooms --json" "$(printf '%s' "$out" | head -3)"
printf '%s' "$out" | grep -q 'carol_messages' && ok "  and names carol_messages" || bad "  rooms did not name the real table"

echo
echo "=== the skills' own queries run, verbatim, and hand each step what the next needs ==="
# The SQL is taken out of the docs a skill reads, not retyped: a test of a paraphrase proves
# nothing about the query an agent will actually run. sqlblock <file> <n>: the n-th ```sql block.
SKILL="$ROOT/memhouse/delivery/plugin/skills/recall/SKILL.md"
sqlblock() { awk -v want="$2" '/^```sql/{n++; if (n==want) {on=1; next}} /^```/{on=0} on' "$1"; }
# Fixtures: session s1 holds a superseded parse (epoch 0) beside the current one (epoch 1),
# and a subagent block numbered far above the parent's turns, the way the shipper folds one.
SID='claude-code:s1'
A "INSERT INTO mem.carol_messages (session_id, seq, source, host, ts, role, text, line_hash, epoch, is_subagent, extra) VALUES
 ('$SID',0,'claude-code','h',now64(3)-60,'user','old parse: the needle',10,0,0,'{}'),
 ('$SID',1000000000,'claude-code','h',now64(3)-55,'assistant','old subagent turn',11,0,1,'{\"agent\":{\"id\":\"a1\",\"description\":\"look\"}}'),
 ('$SID',0,'claude-code','h',now64(3)-50,'user','start',20,1,0,'{}'),
 ('$SID',1,'claude-code','h',now64(3)-49,'assistant','thinking',21,1,0,'{}'),
 ('$SID',2,'claude-code','h',now64(3)-48,'user','here is the needle',22,1,0,'{}'),
 ('$SID',3,'claude-code','h',now64(3)-47,'assistant','fixed it',23,1,0,'{}'),
 ('$SID',1000000000,'claude-code','h',now64(3)-46,'user','subagent task',24,1,1,'{\"agent\":{\"id\":\"a1\",\"description\":\"look\"}}'),
 ('$SID',1000000001,'claude-code','h',now64(3)-45,'assistant','subagent answer',25,1,1,'{\"agent\":{\"id\":\"a1\",\"description\":\"look\"}}')" >/dev/null
A "INSERT INTO mem.carol_sessions (session_id, source, host, name, project, created_at, last_updated_at, message_count, extra) VALUES ('$SID','claude-code','h','start','proj', now64(3)-60, now64(3)-45, 6, '{}')" >/dev/null
sub() { sed -e "s/<sid>/$SID/g" -e "s/<uid>/$UID_/g" -e "s/<hit_seq>/$HIT/g" -e "s/<agent>/a1/g"; }

# Step 1: the search. It must return the session's user_id and hit_seq — step 2 needs both.
r=$(run_recipe "$WORK/carol.env" "$(sqlblock "$SKILL" 1) FORMAT JSONEachRow")
# the row for s1 (the recipe section above left another matching session behind)
row() { printf '%s' "$r" | SID="$SID" F="$1" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const l of d.split("\n")){try{const r=JSON.parse(l);if(r.session_id===process.env.SID){process.stdout.write(String(r[process.env.F]??""));return}}catch{}}})'; }
UID_=$(row user_id); HIT=$(row hit_seq); HITS=$(row hits)
[ -n "$UID_" ] && [ "$HIT" = "2" ] && ok "recall step 1 runs and returns user_id and hit_seq (= 2, the current parse's hit)" || bad "recall step 1" "$(printf '%s' "$r" | head -2)"
[ "$HITS" = "1" ] && ok "  and counts the current parse only (1 hit, not 2)" || bad "  step 1 counted a superseded parse ($HITS)" "$r"

# Step 2: the window, by position. Two turns before the hit, the hit and everything after —
# including the subagent block, whose seq is a billion higher — and nothing from epoch 0.
r=$(run_recipe "$WORK/carol.env" "$(sqlblock "$SKILL" 2 | sub) FORMAT TSV")
n=$(printf '%s\n' "$r" | grep -c . || true)
[ "$n" = "6" ] && ok "recall step 2 returns the window by position (6 rows: 0,1,2,3 and the subagent's 2)" || bad "recall step 2 returned $n rows" "$r"
printf '%s' "$r" | grep -q "old parse\|old subagent" && bad "  step 2 read a superseded parse" || ok "  and no superseded parse"
printf '%s' "$r" | grep -q "subagent answer" && ok "  and crosses the gap into the subagent block" || bad "  the window stopped at the seq gap"

# Recent sessions: the columns the room actually has.
r=$(run_recipe "$WORK/carol.env" "$(sqlblock "$SKILL" 3) FORMAT JSONEachRow")
printf '%s' "$r" | grep -q "\"session_id\":\"$SID\"" && printf '%s' "$r" | grep -q '"last_active":"20' && ok "recall's recent-sessions query runs (started, last_active)" || bad "recall recent sessions" "$(printf '%s' "$r" | head -2)"

# HOUSE.md's subagent queries carry the epoch filter: one subagent, 2 turns, not 3.
HB=$(sqlblock "$DOC" 1)
q1=$(printf '%s\n' "$HB" | awk '/^-- the subagents a session spawned/{on=1; next} /^-- one subagent/{on=0} on' | sub)
q2=$(printf '%s\n' "$HB" | awk '/^-- one subagent/{on=1; next} on' | sub)
r=$(run_recipe "$WORK/carol.env" "$q1 FORMAT TSV")
[ "$(printf '%s' "$r" | cut -f1,3)" = "$(printf 'a1\t2')" ] && ok "HOUSE.md: the subagent list counts the current parse (a1: 2 turns)" || bad "HOUSE.md subagent list" "$r"
r=$(run_recipe "$WORK/carol.env" "$q2 FORMAT TSV")
n=$(printf '%s\n' "$r" | grep -c . || true)
[ "$n" = "2" ] && ok "HOUSE.md: one subagent's transcript has its 2 current turns" || bad "HOUSE.md subagent transcript: $n rows" "$r"

echo
echo "=== the SAME recipe, unprefixed, must be unaffected ==="
A "DROP DATABASE IF EXISTS solo SYNC" >/dev/null; A "DROP USER IF EXISTS dave" >/dev/null
(cd "$WORK" && node "$ROOT/bin/memhouse.js" invite dave --url "$URL" \
   --admin-user "$ADM" --admin-password "$APW" --allow-local --out "$WORK/dave.env" >/dev/null 2>&1)
A "INSERT INTO dave.messages (session_id, seq, source, host, ts, role, text, line_hash) VALUES ('s',0,'x','h',now(),'user','hi',1)" >/dev/null 2>&1
r=$(run_recipe "$WORK/dave.env" "SELECT count() FROM messages FORMAT TSV")
case "$r" in ''|*[!0-9]*) bad "the recipe broke the DEFAULT layout" "$r";;
             *) ok "an ordinary house reads exactly as before ($r row)";; esac

echo
echo "=== cleanup ==="
A "DROP DATABASE IF EXISTS mem SYNC" >/dev/null; A "DROP DATABASE IF EXISTS dave SYNC" >/dev/null
A "DROP USER IF EXISTS carol" >/dev/null; A "DROP USER IF EXISTS dave" >/dev/null
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
