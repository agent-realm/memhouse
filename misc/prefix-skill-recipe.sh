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
(cd "$WORK" && node "$ROOT/bin/memhouse.js" invite carol --url "$URL" --shared-db mem \
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
printf '%s' "$out" | grep -q '"shared": true' && ok "rooms reports a shared house" || bad "rooms --json" "$(printf '%s' "$out" | head -3)"
printf '%s' "$out" | grep -q 'carol_messages' && ok "  and names carol_messages" || bad "  rooms did not name the real table"

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
