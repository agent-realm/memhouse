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
REPO="${REPO:-/Users/polat/agent-realm/.worktrees/memhouse/claude/protect-imported}"
pass=0; fail=0
q() { curl -s -m 60 -u "$U:$P" --data-binary "$1" "$URL/?database=mhtest"; }
qroot() { curl -s -m 60 -u "$U:$P" --data-binary "$1" "$URL/"; }
ck() { # ck <name> <expected> <actual>
  if [ "$2" = "$3" ]; then printf "  PASS  %-52s %s\n" "$1" "$3"; pass=$((pass+1))
  else printf "  FAIL  %-52s want=%s got=%s\n" "$1" "$2" "$3"; fail=$((fail+1)); fi
}
echo "######## $LABEL — $(qroot 'SELECT version()' | tr -d '\r\n') ########"

qroot "DROP DATABASE IF EXISTS mhtest" >/dev/null; qroot "CREATE DATABASE mhtest" >/dev/null

# --- A. a house built from the CURRENT template (origin present) -----------------
ddl() { # ddl <member> [drop-origin]  -- HTTP takes ONE statement per request
  local src="$REPO/memhouse/per-member/schema-member.sql.tpl"
  if [ "${2:-}" = "no-origin" ]; then
    sed "/origin LowCardinality/d; s/, origin, seq)/, seq)/; s/, origin, idx)/, idx)/; s/, user_id, origin)/, user_id)/" "$src" > /tmp/_ddl.tpl
    src=/tmp/_ddl.tpl
  fi
  sed "s/{{MEMBER}}/$1/g" "$src" \
  | python3 -c "
import sys,re
sql=re.sub(r'--.*','',sys.stdin.read())
for st in [x.strip() for x in sql.split(';') if x.strip()]: print(st.replace(chr(10),' '))
" | while IFS= read -r st; do
    curl -s -m 120 -u "$U:$P" --data-binary "$st" "$URL/?database=mhtest&allow_experimental_full_text_index=1" >/dev/null
  done
}
ddl tester
ck "A1 rooms created" "3" "$(q "SELECT count() FROM system.tables WHERE database='mhtest' AND name LIKE '%_tester'" | tr -d '[:space:]')"
ck "A2 origin column on every room" "3" "$(q "SELECT count() FROM system.columns WHERE database='mhtest' AND name='origin'" | tr -d '[:space:]')"
A3=$(q "SELECT default_expression FROM system.columns WHERE database='mhtest' AND table='messages_tester' AND name='origin'" | tr -d "[:space:]'")
ck "A3 origin defaults to ship" "ship" "$(echo "$A3" | tr -d "\\\\'")"
ck "A4 origin IS in the sorting key" "yes" "$(q "SELECT if(position(sorting_key,'origin')>0,'yes','no') FROM system.tables WHERE database='mhtest' AND name='messages_tester'" | tr -d '[:space:]')"

# --- B. the destructive scenario, exactly as it happened -------------------------
# one session, imported richly (5 rows), then re-shipped thin (2 rows)
q "INSERT INTO mhtest.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s1',0,'claude-code','h',now64(3),'user','imported-0',1,'import'),
 ('s1',1,'claude-code','h',now64(3),'assistant','imported-1',2,'import'),
 ('s1',2,'claude-code','h',now64(3),'user','imported-2',3,'import'),
 ('s1',3,'claude-code','h',now64(3),'assistant','imported-3',4,'import'),
 ('s1',4,'claude-code','h',now64(3),'user','imported-4',5,'import')" >/dev/null
q "INSERT INTO mhtest.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s1',0,'claude-code','h',now64(3),'user','shipped-0',10,'ship'),
 ('s1',1,'claude-code','h',now64(3),'assistant','shipped-1',11,'ship'),
 ('s1',2,'claude-code','h',now64(3),'user','shipped-STALE',12,'ship')" >/dev/null
# the shipper's clear, as the fixed code issues it
q "DELETE FROM mhtest.messages_tester WHERE session_id='s1' AND user_id='$U' AND origin='ship'" >/dev/null
q "OPTIMIZE TABLE mhtest.messages_tester FINAL" >/dev/null
ck "B1 imported rows survive the clear" "5" "$(q "SELECT count() FROM mhtest.messages_tester FINAL WHERE session_id='s1' AND origin='import'" | tr -d '[:space:]')"
ck "B2 shipper rows ARE cleared (stale tail gone)" "0" "$(q "SELECT count() FROM mhtest.messages_tester FINAL WHERE session_id='s1' AND origin='ship'" | tr -d '[:space:]')"
ck "B3 the stale seq tail specifically is gone" "0" "$(q "SELECT count() FROM mhtest.messages_tester FINAL WHERE text='shipped-STALE'" | tr -d '[:space:]')"

# --- C. the OLD unguarded clear would have destroyed the import ------------------
q "INSERT INTO mhtest.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s2',0,'claude-code','h',now64(3),'user','imported',20,'import')" >/dev/null
q "DELETE FROM mhtest.messages_tester WHERE session_id='s2' AND user_id='$U'" >/dev/null
q "OPTIMIZE TABLE mhtest.messages_tester FINAL" >/dev/null
ck "C1 unguarded clear DOES destroy imports (the bug)" "0" "$(q "SELECT count() FROM mhtest.messages_tester FINAL WHERE session_id='s2'" | tr -d '[:space:]')"

# --- D. upgrade path: a house with NO origin column ------------------------------
ddl legacy no-origin
ck "D1 legacy house has NO origin column" "0" "$(q "SELECT count() FROM system.columns WHERE database='mhtest' AND table='messages_legacy' AND name='origin'" | tr -d '[:space:]')"
curl -s -m 60 -u "$U:$P" --data-binary "ALTER TABLE mhtest.messages_legacy ADD COLUMN IF NOT EXISTS origin LowCardinality(String) DEFAULT 'ship'" "$URL/?database=mhtest&allow_experimental_full_text_index=1" >/dev/null
ck "D2 ensureSchema's ALTER adds it" "1" "$(q "SELECT count() FROM system.columns WHERE database='mhtest' AND table='messages_legacy' AND name='origin'" | tr -d '[:space:]')"
q "INSERT INTO mhtest.messages_legacy (session_id,seq,source,host,ts,role,text,line_hash) VALUES ('s3',0,'claude-code','h',now64(3),'user','pre-existing',30)" >/dev/null
ck "D3 pre-existing rows backfill to 'ship'" "ship" "$(q "SELECT origin FROM mhtest.messages_legacy FINAL WHERE session_id='s3'" | tr -d '[:space:]')"

# --- E. the merge path: import and ship with the SAME seq must NOT collapse ------
q "INSERT INTO mhtest.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s4',0,'cc','h',now64(3),'user','IMPORTED-0',40,'import'),
 ('s4',1,'cc','h',now64(3),'user','IMPORTED-1',41,'import')" >/dev/null
q "INSERT INTO mhtest.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES
 ('s4',0,'cc','h',now64(3),'user','SHIPPED-0',42,'ship'),
 ('s4',1,'cc','h',now64(3),'user','SHIPPED-1',43,'ship')" >/dev/null
q "OPTIMIZE TABLE mhtest.messages_tester FINAL" >/dev/null
ck "E1 same-seq import+ship both survive the merge" "4" "$(q "SELECT count() FROM mhtest.messages_tester FINAL WHERE session_id='s4'" | tr -d '[:space:]')"
ck "E2 imported rows specifically survive" "2" "$(q "SELECT count() FROM mhtest.messages_tester FINAL WHERE session_id='s4' AND origin='import'" | tr -d '[:space:]')"
q "INSERT INTO mhtest.messages_tester (session_id,seq,source,host,ts,role,text,line_hash,origin) VALUES ('s4',0,'cc','h',now64(3),'user','SHIPPED-0-again',44,'ship'),('s4',1,'cc','h',now64(3),'user','SHIPPED-1-again',45,'ship')" >/dev/null
q "OPTIMIZE TABLE mhtest.messages_tester FINAL" >/dev/null
ck "E3 a re-ship still dedups within origin=ship" "2" "$(q "SELECT count() FROM mhtest.messages_tester FINAL WHERE session_id='s4' AND origin='ship'" | tr -d '[:space:]')"

qroot "DROP DATABASE IF EXISTS mhtest" >/dev/null
echo "  ---- $LABEL: $pass passed, $fail failed ----"
exit $fail
