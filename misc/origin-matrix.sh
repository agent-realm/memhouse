#!/usr/bin/env bash
# Does the origin guard protect imported rows WITHOUT breaking the clear it guards?
#
#   origin-matrix.sh <label> <clickhouse-url> <user> <password>
#
# The clear exists so a shorter re-parse cannot leave a stale seq tail behind. A fix that
# protects imported rows by weakening the clear would trade one silent data bug for
# another, so every case below is paired: something must survive, and something must still
# be removed.
set -uo pipefail
LABEL="$1"; URL="$2"; U="$3"; P="$4"
# Default to the checkout this script lives in, so it works from any worktree.
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
pass=0; fail=0
# A fixed database name means two runs against the same server drop each other's tables
# mid-flight — which is exactly what happens when parallel acceptance agents share a lab.
# Derive it from the label and the pid instead. Override with DB= if you want a stable one.
DB="${DB:-mhtest_$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9' '_' | cut -c1-24)_$$}"
q() { curl -s -m 60 -u "$U:$P" --data-binary "$1" "$URL/?database=$DB"; }
qroot() { curl -s -m 60 -u "$U:$P" --data-binary "$1" "$URL/"; }
ck() { # ck <name> <expected> <actual>
  if [ "$2" = "$3" ]; then printf "  PASS  %-52s %s\n" "$1" "$3"; pass=$((pass+1))
  else printf "  FAIL  %-52s want=%s got=%s\n" "$1" "$2" "$3"; fail=$((fail+1)); fi
}
echo "######## $LABEL — $(qroot 'SELECT version()' | tr -d '\r\n') ########"

qroot "DROP DATABASE IF EXISTS $DB" >/dev/null; qroot "CREATE DATABASE $DB" >/dev/null

# --- A. a house built from the CURRENT template (origin present) -----------------
ddl() { # ddl <member> [drop-origin]  -- HTTP takes ONE statement per request
  local src="$REPO/memhouse/per-member/schema-member.sql.tpl"
  if [ "${2:-}" = "no-origin" ]; then
    sed "/origin LowCardinality/d; s/, origin, seq)/, seq)/; s/, origin, idx)/, idx)/" "$src" > /tmp/_ddl.$$.tpl
    src=/tmp/_ddl.$$.tpl
  fi
  sed "s/{{MEMBER}}/$1/g" "$src" \
  | python3 -c "
import sys,re
sql=re.sub(r'--.*','',sys.stdin.read())
for st in [x.strip() for x in sql.split(';') if x.strip()]: print(st.replace(chr(10),' '))
" | while IFS= read -r st; do
    curl -s -m 120 -u "$U:$P" --data-binary "$st" "$URL/?database=$DB&allow_experimental_full_text_index=1" >/dev/null
  done
}
ddl tester
ck "A1 rooms created" "3" "$(q "SELECT count() FROM system.tables WHERE database='$DB' AND name LIKE '%_tester'" | tr -d '[:space:]')"
ck "A2 origin column on every room" "3" "$(q "SELECT count() FROM system.columns WHERE database='$DB' AND name='origin'" | tr -d '[:space:]')"
A3=$(q "SELECT default_expression FROM system.columns WHERE database='$DB' AND table='messages_tester' AND name='origin'" | tr -d "[:space:]'")
ck "A3 origin defaults to ship" "ship" "$(echo "$A3" | tr -d "\\\\'")"
ck "A4 origin IS in the messages sorting key" "yes" "$(q "SELECT if(position(sorting_key,'origin')>0,'yes','no') FROM system.tables WHERE database='$DB' AND name='messages_tester'" | tr -d '[:space:]')"
ck "A5 origin IS in the tool_calls sorting key" "yes" "$(q "SELECT if(position(sorting_key,'origin')>0,'yes','no') FROM system.tables WHERE database='$DB' AND name='tool_calls_tester'" | tr -d '[:space:]')"
# sessions is the exception, and getting it wrong is a real bug that shipped in 0.4.4:
# origin in this key gives a session TWO metadata rows, so the rollup joins its messages
# twice. Measured on a live house: +1,764 messages and +655M tokens from one extra row.
ck "A6 origin is NOT in the sessions sorting key" "no" "$(q "SELECT if(position(sorting_key,'origin')>0,'yes','no') FROM system.tables WHERE database='$DB' AND name='sessions_tester'" | tr -d '[:space:]')"

# --- F. one session row, whatever the origin --------------------------------------
q "INSERT INTO $DB.sessions_tester (session_id,source,host,name,created_at,last_updated_at,message_count,origin) VALUES
 ('f1','claude-code','h','imported title',now64(3),now64(3),9,'import')" >/dev/null
q "INSERT INTO $DB.sessions_tester (session_id,source,host,name,created_at,last_updated_at,message_count,origin) VALUES
 ('f1','claude-code','h','shipped title',now64(3),now64(3),4,'ship')" >/dev/null
q "OPTIMIZE TABLE $DB.sessions_tester FINAL" >/dev/null
ck "F1 an imported+shipped session collapses to ONE row" "1" "$(q "SELECT count() FROM $DB.sessions_tester FINAL WHERE session_id='f1'" | tr -d '[:space:]')"
ck "F2 the surviving row is the newer (shipped) one" "shippedtitle" "$(q "SELECT name FROM $DB.sessions_tester FINAL WHERE session_id='f1'" | tr -d '[:space:]')"

# --- B. the destructive scenario, exactly as it happened -------------------------
# one session, imported richly (5 rows), then re-shipped thin (2 rows)
q "INSERT INTO $DB.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s1',0,'claude-code','h',now64(3),'user','imported-0',1,'import'),
 ('s1',1,'claude-code','h',now64(3),'assistant','imported-1',2,'import'),
 ('s1',2,'claude-code','h',now64(3),'user','imported-2',3,'import'),
 ('s1',3,'claude-code','h',now64(3),'assistant','imported-3',4,'import'),
 ('s1',4,'claude-code','h',now64(3),'user','imported-4',5,'import')" >/dev/null
q "INSERT INTO $DB.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s1',0,'claude-code','h',now64(3),'user','shipped-0',10,'ship'),
 ('s1',1,'claude-code','h',now64(3),'assistant','shipped-1',11,'ship'),
 ('s1',2,'claude-code','h',now64(3),'user','shipped-STALE',12,'ship')" >/dev/null
# the shipper's clear, as the fixed code issues it
q "DELETE FROM $DB.messages_tester WHERE session_id='s1' AND user_id='$U' AND origin='ship'" >/dev/null
q "OPTIMIZE TABLE $DB.messages_tester FINAL" >/dev/null
ck "B1 imported rows survive the clear" "5" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE session_id='s1' AND origin='import'" | tr -d '[:space:]')"
ck "B2 shipper rows ARE cleared (stale tail gone)" "0" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE session_id='s1' AND origin='ship'" | tr -d '[:space:]')"
ck "B3 the stale seq tail specifically is gone" "0" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE text='shipped-STALE'" | tr -d '[:space:]')"

# --- C. the OLD unguarded clear would have destroyed the import ------------------
q "INSERT INTO $DB.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s2',0,'claude-code','h',now64(3),'user','imported',20,'import')" >/dev/null
q "DELETE FROM $DB.messages_tester WHERE session_id='s2' AND user_id='$U'" >/dev/null
q "OPTIMIZE TABLE $DB.messages_tester FINAL" >/dev/null
ck "C1 unguarded clear DOES destroy imports (the bug)" "0" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE session_id='s2'" | tr -d '[:space:]')"

# --- D. upgrade path: a house with NO origin column ------------------------------
ddl legacy no-origin
ck "D1 legacy house has NO origin column" "0" "$(q "SELECT count() FROM system.columns WHERE database='$DB' AND table='messages_legacy' AND name='origin'" | tr -d '[:space:]')"
curl -s -m 60 -u "$U:$P" --data-binary "ALTER TABLE $DB.messages_legacy ADD COLUMN IF NOT EXISTS origin LowCardinality(String) DEFAULT 'ship'" "$URL/?database=$DB&allow_experimental_full_text_index=1" >/dev/null
ck "D2 ensureSchema's ALTER adds it" "1" "$(q "SELECT count() FROM system.columns WHERE database='$DB' AND table='messages_legacy' AND name='origin'" | tr -d '[:space:]')"
q "INSERT INTO $DB.messages_legacy (session_id,seq,source,host,ts,role,text,line_hash) VALUES ('s3',0,'claude-code','h',now64(3),'user','pre-existing',30)" >/dev/null
ck "D3 pre-existing rows backfill to 'ship'" "ship" "$(q "SELECT origin FROM $DB.messages_legacy FINAL WHERE session_id='s3'" | tr -d '[:space:]')"

# --- E. the merge path: import and ship with the SAME seq must NOT collapse ------
q "INSERT INTO $DB.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s4',0,'cc','h',now64(3),'user','IMPORTED-0',40,'import'),
 ('s4',1,'cc','h',now64(3),'user','IMPORTED-1',41,'import')" >/dev/null
q "INSERT INTO $DB.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s4',0,'cc','h',now64(3),'user','SHIPPED-0',42,'ship'),
 ('s4',1,'cc','h',now64(3),'user','SHIPPED-1',43,'ship')" >/dev/null
q "OPTIMIZE TABLE $DB.messages_tester FINAL" >/dev/null
ck "E1 same-seq import+ship both survive the merge" "4" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE session_id='s4'" | tr -d '[:space:]')"
ck "E2 imported rows specifically survive" "2" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE session_id='s4' AND origin='import'" | tr -d '[:space:]')"
q "INSERT INTO $DB.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES ('s4',0,'cc','h',now64(3),'user','SHIPPED-0-again',44,'ship'),('s4',1,'cc','h',now64(3),'user','SHIPPED-1-again',45,'ship')" >/dev/null
q "OPTIMIZE TABLE $DB.messages_tester FINAL" >/dev/null
ck "E3 a re-ship still dedups within origin=ship" "2" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE session_id='s4' AND origin='ship'" | tr -d '[:space:]')"

# --- G. the skip count must ignore imported rows ---------------------------------
# loadExisting() compares message_count (rows the SHIPPER wrote) against a count from the
# messages room. Using count() there means any session carrying imported rows never looks
# intact and re-ships on every pass -- no data lost, but the incremental skip silently
# stops working. countIf(origin='ship') is the count that can match.
q "INSERT INTO $DB.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('g1',0,'cc','h',now64(3),'user','shipped',50,'ship'),
 ('g1',1,'cc','h',now64(3),'user','shipped',51,'ship'),
 ('g1',0,'cc','h',now64(3),'user','imported-extra',52,'import')" >/dev/null
q "OPTIMIZE TABLE $DB.messages_tester FINAL" >/dev/null
ck "G1 countIf(ship) matches what the shipper wrote" "2" "$(q "SELECT countIf(origin='ship') FROM $DB.messages_tester FINAL WHERE session_id='g1'" | tr -d '[:space:]')"
ck "G2 plain count() does NOT (why the skip broke)" "3" "$(q "SELECT count() FROM $DB.messages_tester FINAL WHERE session_id='g1'" | tr -d '[:space:]')"

qroot "DROP DATABASE IF EXISTS $DB" >/dev/null
echo "  ---- $LABEL: $pass passed, $fail failed ----"
exit $fail
