#!/usr/bin/env bash
# convert-matrix: a real pre-one-layout house, built by the PUBLISHED 0.17.1, converted by
# this build, then a member's own env repaired by this build's shipper. The rehearsal for
# moving zeo. Usage: convert-matrix.sh <url> <admin-user> <admin-password>
set -u
URL=${1:?usage: convert-matrix.sh <url> <admin-user> <admin-password>}; ADM=$2; ADMPW=$3
HERE=$(cd "$(dirname "$0")/.." && pwd); NEW="node $HERE/bin/memhouse.js"
WORK=$(mktemp -d); pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
A()   { curl -sS --max-time 60 --user "$ADM:$ADMPW" --data-binary "$1" "$URL/"; }
echo "convert matrix against $URL"
# ── the old world: memhouse 0.17.1 from npm ───────────────────────────────────────
OLDP="$WORK/old"; npm install -g --prefix "$OLDP" memhouse@0.17.1 >/dev/null 2>&1 || { bad "could not install memhouse@0.17.1 from npm"; exit 1; }
OLD="$OLDP/bin/memhouse"; ok "old build: $($OLD --version)"
# 0.17.1 predates MEMHOUSE_CLAUDE_ROOTS and would ship every Claude dir under $HOME; give it a
# home that holds only the fixture. (It shipped 812 real sessions into a scratch container once.)
FAKEHOME="$WORK/fakehome"; mkdir -p "$FAKEHOME/.claude/projects/-Users-x-proj"; ln -s "$FAKEHOME/.claude" "$WORK/fx"
printf '{"type":"user","uuid":"u1","sessionId":"s1","timestamp":"2026-09-16T10:00:00Z","cwd":"/Users/x/proj","message":{"role":"user","content":"hello old house"}}\n{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"s1","timestamp":"2026-09-16T10:00:05Z","cwd":"/Users/x/proj","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":5,"output_tokens":2}}}\n' > "$FAKEHOME/.claude/projects/-Users-x-proj/s1.jsonl"
for m in cm_polat cm_mir; do
  H="$WORK/home-$m"; mkdir -p "$H"
  # --db $m: with --member, 0.17.1 defaulted the database to the ADMIN's name; zeo's shape is db = member
  HOME="$FAKEHOME" MEMHOUSE_HOME="$H" $OLD install --url "$URL" --admin-user "$ADM" --admin-password "$ADMPW" --member "$m" --member-password "pw-$m" --db "$m" --yes --no-ship >/dev/null 2>&1
  HOME="$FAKEHOME" MEMHOUSE_HOME="$H" $OLD ship >/dev/null 2>&1
done
n=$(A "SELECT count() FROM system.tables WHERE database='cm_polat' AND name='messages' FORMAT TSV" | tr -d '\n')
[ "$n" = 1 ] && ok "0.17.1 built a database-per-member house (cm_polat.messages exists)" || bad "old house not built" "$n"
rows_before=$(A "SELECT count() FROM cm_polat.messages FORMAT TSV" | tr -d '\n'); [ "${rows_before:-0}" -gt 0 ] && ok "old house holds rows ($rows_before)" || bad "old house empty"
HOME="$FAKEHOME" MEMHOUSE_HOME="$WORK/home-cm_polat" $OLD share cm_mir >/dev/null 2>&1
A "SHOW GRANTS FOR cm_mir FORMAT TSV" | grep -q "SELECT ON cm_polat" && ok "0.17 share in place (cm_mir reads cm_polat.*)" || bad "0.17 share not recorded"
# ── convert with this build ────────────────────────────────────────────────────────
out=$($NEW convert --url "$URL" --admin-user "$ADM" --admin-password "$ADMPW" --dry-run 2>&1)
case "$out" in *"cm_polat.messages TO mem.cm_polat_messages"*) ok "dry-run plans the rename" ;; *) bad "dry-run did not plan the rename" "$(printf '%s' "$out" | head -3)";; esac
[ "$(A "SELECT count() FROM system.tables WHERE database='mem' FORMAT TSV" | tr -d '\n')" = 0 ] && ok "dry-run touched nothing" || bad "dry-run changed the house"
mkdir -p "$WORK/guides"
out=$($NEW convert --url "$URL" --admin-user "$ADM" --admin-password "$ADMPW" --yes --guides --out "$WORK/guides" 2>&1)
case "$out" in *"2/2 converted"*) ok "convert: 2/2 members" ;; *) bad "convert did not finish" "$(printf '%s' "$out" | grep -E '✗|stopped' | head -2)";; esac
[ "$(A "SELECT count() FROM system.tables WHERE database='mem' AND name IN ('cm_polat_messages','cm_polat_sessions','cm_polat_tool_calls','cm_polat_meta','cm_polat_events') FORMAT TSV" | tr -d '\n')" = 5 ] && ok "  five rooms under the member's name in mem" || bad "  rooms missing in mem"
[ "$(A "SELECT count() FROM mem.cm_polat_messages FORMAT TSV" | tr -d '\n')" = "$rows_before" ] && ok "  every row still there ($rows_before)" || bad "  row count changed"
[ "$(A "SELECT count() FROM system.databases WHERE name IN ('cm_polat','cm_mir') FORMAT TSV" | tr -d '\n')" = 0 ] && ok "  the emptied databases are gone" || bad "  old databases remain"
A "SHOW GRANTS FOR cm_polat FORMAT TSV" | grep -q "ON mem.cm_polat_\* TO cm_polat WITH GRANT OPTION" && ok "  one-layout wildcard grant" || bad "  grant not swapped" "$(A "SHOW GRANTS FOR cm_polat FORMAT TSV" | head -3)"
A "SHOW GRANTS FOR cm_polat FORMAT TSV" | grep -q "ON cm_polat\.\*" && bad "  the database-wide grant survives" || ok "  database-wide grant revoked"
M(){ curl -sS --max-time 30 --user "cm_mir:pw-cm_mir" --data-binary "$1" "$URL/?database=mem" 2>&1; }
[ "$(M "SELECT count() FROM cm_polat_messages FORMAT TSV" | tr -d '\n')" = "$rows_before" ] && ok "  the share followed: cm_mir reads mem.cm_polat_messages" || bad "  share lost" "$(M 'SELECT count() FROM cm_polat_messages' | head -1)"
P(){ curl -sS --max-time 30 --user "cm_polat:pw-cm_polat" --data-binary "$1" "$URL/?database=mem" 2>&1; }
P "SELECT count() FROM cm_mir_messages FORMAT TSV" | grep -qE "Not enough privileges|ACCESS_DENIED" && ok "  isolation holds: cm_polat cannot read cm_mir's rooms" || bad "  cm_polat can read cm_mir"
[ "$(A "SELECT count() FROM mem.cm_polat_events WHERE kind='layout' AND status='converted' FORMAT TSV" | tr -d '\n')" = 1 ] && ok "  conversion recorded in the member's events room" || bad "  no event recorded"
# ── the member side: an old env, this build ────────────────────────────────────────
H="$WORK/home-cm_polat"; grep -q "^MEMHOUSE_DB='cm_polat'" "$H/env" && ok "member env still says the old database (as a real member's would)"
out=$(MEMHOUSE_HOME="$H" $NEW doctor 2>&1); case "$out" in *"rooms moved to mem.cm_polat_*"*) ok "doctor names the move and the fix" ;; *) bad "doctor silent about the move" "$(printf '%s' "$out" | grep -E '✗' | head -2)";; esac
out=$(MEMHOUSE_HOME="$H" MEMHOUSE_EDITORS=claude MEMHOUSE_CLAUDE_ROOTS="$FAKEHOME/.claude" $NEW ship 2>&1)
case "$out" in *"your rooms moved"*) ok "the shipper adopted the moved house on its own" ;; *) bad "shipper did not adopt" "$(printf '%s' "$out" | head -3)";; esac
grep -q "^MEMHOUSE_DB='mem'" "$H/env" && ok "  env rewritten to MEMHOUSE_DB=mem" || bad "  env not rewritten"
case "$out" in *"shipped "*) ok "  and the pass shipped into mem" ;; *) bad "  pass did not ship" "$(printf '%s' "$out" | grep -E 'failed' | head -1)";; esac
out=$(MEMHOUSE_HOME="$H" $NEW instance 2>&1); case "$out" in *"db mem"*"member cm_polat"*) ok "  instance: house mem, member cm_polat" ;; *) bad "  instance wrong" "$(printf '%s' "$out" | grep house)";; esac
# ── the guides ───────────────────────────────────────────────────────────────────────
for m in cm_polat cm_mir; do
  g="$WORK/guides/MEMHOUSE-UPGRADE-$m.md"
  [ -f "$g" ] && grep -q "mem.${m}_messages" "$g" && ! grep -q '{{' "$g" && ok "guide for $m: names their rooms, no unrendered placeholder" || bad "guide for $m missing or unrendered"
done
grep -qE "memhouse update" "$WORK/guides/MEMHOUSE-UPGRADE-cm_polat.md" && ok "  the guide's one command is memhouse update" || bad "  guide lacks the command"
# ── cleanup ──────────────────────────────────────────────────────────────────────────
for t in messages sessions tool_calls meta events session_stats session_model_stats session_tool_stats; do for m in cm_polat cm_mir; do A "DROP TABLE IF EXISTS mem.${m}_$t SYNC" >/dev/null 2>&1; done; done
for m in cm_polat cm_mir; do A "DROP USER IF EXISTS $m" >/dev/null 2>&1; A "DROP DATABASE IF EXISTS $m SYNC" >/dev/null 2>&1; done
echo "  $pass passed, $fail failed"; [ "$fail" -eq 0 ]
