#!/usr/bin/env bash
# misc/invite-matrix.sh — the invite capability gate, against a REAL ClickHouse.
#
# Every case here is a bug that actually shipped or nearly shipped, and none of them can
# be caught by a unit test or on a developer's own machine:
#
#   1. The capability probe was `SELECT 1 FROM system.users`. Since 0.12.6 every member
#      holds SHOW USERS, so every member passed, was told "it can manage users on this
#      house", and then died at CREATE DATABASE with a raw ACCESS_DENIED.
#   2. The replacement probe read grants with a statement that already carried FORMAT,
#      so it was a syntax error — which read as "no grants" and refused EVERY credential,
#      a genuine superuser included. Invisible wherever the local credential is a member.
#   3. Reachability was folded into the grants read, so an unreachable --url reported
#      "you are only a member" and sent the reader after a privilege they already had.
#
# Usage: misc/invite-matrix.sh <url> <admin-user> <admin-password>
set -euo pipefail

URL=${1:?usage: invite-matrix.sh <url> <admin-user> <admin-password>}
ADM=${2:?}
ADMPW=${3:?}
CLI="node $(cd "$(dirname "$0")/.." && pwd)/bin/memhouse.js"

# Credentials resolve flags > MEMHOUSE_* env > env file. This script switches identity by
# writing an env FILE and pointing MEMHOUSE_HOME at it, so ANY inherited MEMHOUSE_USER or
# MEMHOUSE_PASSWORD silently outranks that and every case runs as the wrong user — the
# member cases then "pass" as an admin and the suite reports success while testing
# nothing. Seen for real: sourcing an admin env before invoking made 2 of 9 fail and the
# rest meaningless.
unset MEMHOUSE_URL MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB MEMHOUSE_PORT
WORK=$(mktemp -d)
# Never read this machine's real ~/.memhouse — a test once took its database name from it.
export MEMHOUSE_HOME="$WORK/nohome"; mkdir -p "$MEMHOUSE_HOME"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
q()    { curl -sS --user "$ADM:$ADMPW" --data-binary "$1" "$URL/"; }

echo "invite matrix against $URL"

# ── a member is what an invitee gets: no CREATE USER, no CREATE DATABASE ────────────
q "DROP USER IF EXISTS im_member" >/dev/null
q "DROP DATABASE IF EXISTS im_member SYNC" >/dev/null
q "CREATE DATABASE im_member" >/dev/null
q "CREATE USER im_member IDENTIFIED BY 'mpw'" >/dev/null
q "GRANT ALL ON im_member.* TO im_member WITH GRANT OPTION" >/dev/null
q "GRANT SHOW USERS ON *.* TO im_member" >/dev/null   # the grant that fooled the old probe

export MEMHOUSE_HOME="$WORK/member"; mkdir -p "$MEMHOUSE_HOME"
cat > "$MEMHOUSE_HOME/env" <<EOF
MEMHOUSE_URL='$URL'
MEMHOUSE_USER='im_member'
MEMHOUSE_PASSWORD='mpw'
MEMHOUSE_DB='im_member'
EOF

out=$($CLI invite im_target --url "$URL" --allow-local 2>&1 || true)
case "$out" in
  *"is a MEMBER of this ClickHouse"*) ok "a member is refused, and told why" ;;
  *"it can create users and houses here"*) bad "a member was accepted as an admin" "$out" ;;
  *) bad "a member got an unexpected refusal" "$(printf '%s' "$out" | head -3)" ;;
esac
if q "SELECT count() FROM system.users WHERE name='im_target'" | grep -qx 0; then
  ok "the refused invite created nothing"
else
  bad "the refused invite left a user behind"
fi

# ── whoami agrees with invite about who this is ────────────────────────────────────
# These two must never disagree: invite refusing while whoami says "administrator" (or
# the reverse) is how a user ends up chasing a privilege they already hold.
w=$($CLI whoami --json 2>&1 || true)
printf '%s' "$w" | grep -q '"canProvision": false' \
  && ok "whoami calls the member a member" || bad "whoami misjudged the member" "$w"
printf '%s' "$w" | grep -q '"role": "member"' \
  && ok "whoami names the role" || bad "whoami role wrong" "$w"
printf '%s' "$w" | grep -qi "$(printf 'mpw')" \
  && bad "whoami leaked the password" || ok "whoami prints no password"

# ── --print-sql is the member's way out: offline, no credential ─────────────────────
sql=$($CLI invite im_target --url "$URL" --allow-local --print-sql 2>&1 || true)
n=$(printf '%s' "$sql" | grep -cE '^(CREATE|GRANT|ALTER)' || true)
[ "$n" -ge 6 ] && ok "--print-sql emits the plan ($n statements)" || bad "--print-sql emitted $n statements" "$sql"
printf '%s' "$sql" | grep -q "MEMHOUSE_PASSWORD=" \
  && ok "--print-sql carries the handoff credential" || bad "--print-sql omitted the handoff lines"

# ── an admin IS accepted — the bug that refused everyone would fail here ────────────
export MEMHOUSE_HOME="$WORK/admin"; mkdir -p "$MEMHOUSE_HOME"
cat > "$MEMHOUSE_HOME/env" <<EOF
MEMHOUSE_URL='$URL'
MEMHOUSE_USER='$ADM'
MEMHOUSE_PASSWORD='$ADMPW'
MEMHOUSE_DB='default'
EOF
out=$(cd "$WORK" && $CLI invite im_made --url "$URL" --allow-local 2>&1 || true)
case "$out" in
  *"invite written"*) ok "an admin credential still provisions" ;;
  *) bad "an admin credential was refused" "$(printf '%s' "$out" | head -4)" ;;
esac
q "SELECT count() FROM system.users WHERE name='im_made'" | grep -qx 1 \
  && ok "the invited user exists" || bad "the invited user was not created"

# whoami must agree from the other side too
w=$(cd "$WORK" && $CLI whoami --json 2>&1 || true)
printf '%s' "$w" | grep -q '"canProvision": true' \
  && ok "whoami calls the admin an admin" || bad "whoami misjudged the admin" "$w"

# and --admin must pick up an environment credential
w=$(cd "$WORK" && MEMHOUSE_ADMIN_USER="$ADM" MEMHOUSE_ADMIN_PASSWORD="$ADMPW" $CLI whoami --admin --json 2>&1 || true)
printf '%s' "$w" | grep -q 'MEMHOUSE_ADMIN_\* environment' \
  && ok "whoami --admin reads MEMHOUSE_ADMIN_*" || bad "whoami --admin ignored the env" "$w"

# ── an unreachable --url is reported as unreachable, not as a privilege problem ─────
out=$($CLI invite im_x --url http://127.0.0.1:59999 --allow-local 2>&1 || true)
case "$out" in
  *"cannot reach"*) ok "an unreachable url says so" ;;
  *"is a MEMBER"*)  bad "unreachable url blamed the credential" "$out" ;;
  *) bad "unreachable url gave an unexpected error" "$(printf '%s' "$out" | head -3)" ;;
esac

# ── an occupied house is refused unless --adopt ─────────────────────────────────────
# The house needs ROOMS before it can hold a message, and the guard counts messages —
# a bare CREATE DATABASE is not an occupied house. Build them the way a member would.
export MEMHOUSE_HOME="$WORK/seed"; mkdir -p "$MEMHOUSE_HOME"
$CLI install --url "$URL" --user im_member --password mpw --db im_member \
  --yes --no-ship >/dev/null 2>&1 || true
q "INSERT INTO im_member.im_member_messages (session_id, seq, source, host, ts, role, text, line_hash) VALUES ('s',0,'x','h',now(),'user','hi',1)" >/dev/null 2>&1 || true
seeded=$(q "SELECT count() FROM im_member.im_member_messages" 2>/dev/null || echo 0)
export MEMHOUSE_HOME="$WORK/admin"
if [ "${seeded:-0}" = "0" ]; then
  bad "could not seed an occupied house" "rooms missing or insert refused"
else
  # ONE layout: a second member in the same database is the ordinary case — they get rooms
  # named for them and a grant on exactly those. What is refused is re-using a NAME whose
  # rooms already hold messages (below). The invariant this used to assert — "a database has
  # one owner or per-member rooms" — is now a tautology: nobody is ever granted the database.
  out=$(cd "$WORK" && $CLI invite im_occupy --url "$URL" --allow-local --db im_member --member-password opw 2>&1 || true)
  case "$out" in
    *"invite written"*) ok "a second member joins the same house" ;;
    *) bad "a second member was refused" "$(printf '%s' "$out" | grep '✗' | head -2)" ;;
  esac
  r=$(curl -sS -u im_occupy:opw --data-binary "SELECT count() FROM im_member.im_member_messages" "$URL/" 2>&1 | head -1)
  case "$r" in *ACCESS_DENIED*|*"Not enough privileges"*) ok "  and cannot read the first member's rooms" ;; *) bad "  LEAK: second member reads the first's rooms" "$r" ;; esac
  out=$(cd "$WORK" && $CLI invite im_member --url "$URL" --allow-local --db im_member 2>&1 || true)
  case "$out" in
    *"already exists and holds"*) ok "re-inviting the owner warns the house holds messages" ;;
    *) bad "an occupied house was not refused" "$(printf '%s' "$out" | head -3)" ;;
  esac
  out=$(cd "$WORK" && $CLI invite im_member --url "$URL" --allow-local --db im_member --adopt 2>&1 || true)
  case "$out" in
    *"adopting existing house"*) ok "--adopt takes over one's own house, loudly" ;;
    *) bad "--adopt did not allow a takeover" "$(printf '%s' "$out" | head -3)" ;;
  esac
fi

# ── bare `memhouse` beside an invite file offers to process it ────────────────────────
# The invitee's own path: an invite-<name>.env in the current directory, and bare memhouse.
D="$WORK/inbox"; mkdir -p "$D"
( cd "$D" && MEMHOUSE_CHANNEL=team $CLI invite im_bare --url "$URL" --allow-local --admin-user "$ADM" --admin-password "$ADMPW" --out "$D/invite-im_bare.env" >/dev/null 2>&1 )
if [ ! -f "$D/invite-im_bare.env" ]; then
  bad "could not stage an invite file for the bare-memhouse case"
else
  H="$WORK/bare-home"; mkdir -p "$H"
  # non-TTY, no --yes: it must OFFER and change nothing.
  out=$( cd "$D" && MEMHOUSE_HOME="$H" $CLI </dev/null 2>&1 || true )
  case "$out" in *"found an invitation"*) ok "bare memhouse offers the nearby invite" ;; *) bad "bare memhouse did not offer the invite" "$(printf '%s' "$out" | head -2)" ;; esac
  case "$out" in *im_bare*) ok "  and names the member it would join as" ;; *) bad "  did not name the member" ;; esac
  [ -f "$D/invite-im_bare.env" ] && ok "  the offer alone changes nothing (file kept)" || bad "  the file was consumed without a yes"
  [ -f "$H/env" ] && bad "  it joined without a yes" || ok "  and nothing was installed"
  case "$out" in *"$ADMPW"*|*PASSWORD*) bad "  LEAK: a secret appeared in the offer" ;; *) ok "  the offer prints no secret" ;; esac
  # --yes: it must join and consume the file.
  out=$( cd "$D" && MEMHOUSE_HOME="$H" $CLI --yes </dev/null 2>&1 || true )
  case "$out" in *installed*) ok "memhouse --yes joins from the nearby invite" ;; *) bad "memhouse --yes did not join" "$(printf '%s' "$out" | grep -i '✗\|error' | head -1)" ;; esac
  [ -f "$D/invite-im_bare.env" ] && bad "  the spent invite file was not removed" || ok "  the spent invite file is gone"
  grep -q "MEMHOUSE_USER='im_bare'" "$H/env" 2>/dev/null && ok "  installed as the invited member" || bad "  env not written as im_bare"
  # the invite carried the inviter's channel; the joined env must keep it — or the member's first
  # `memhouse update` follows `latest` onto the other line (a 0.18 member was downgraded to 0.17.1)
  grep -q "^MEMHOUSE_CHANNEL='team'" "$H/env" 2>/dev/null && ok "  the joined env keeps the invite's channel (team)" || bad "  the joined env lost the invite's channel"
  # the daemon that join spawned must use the ROTATED password, not the invite's. A drill
  # member's shipper failed every pass with "Authentication failed" while the CLI worked.
  sleep 10
  if grep -q "was rejected by\|Authentication failed" "$H/logs/shipper.log" 2>/dev/null; then
    grep -q "adopting it and retrying" "$H/logs/shipper.log" && ok "the shipper adopted the rotated credential (recovered)" || bad "the shipper spawned by join holds the INVITE password" "$(grep -m1 'rejected\|Authentication' "$H/logs/shipper.log")"
  else ok "the shipper spawned by join authenticates with the rotated password"; fi
  ( cd "$D" && MEMHOUSE_HOME="$H" $CLI stop >/dev/null 2>&1 || true )
  # no invite present: bare memhouse falls back to help, not an offer.
  E="$WORK/empty"; mkdir -p "$E"    # a clean dir — earlier cases dropped invite files in $WORK
  out=$( cd "$E" && MEMHOUSE_HOME="$WORK/nohome" $CLI </dev/null 2>&1 || true )
  case "$out" in *"agent conversation memory"*) ok "bare memhouse with no invite prints help" ;; *) bad "bare memhouse without an invite did not print help" "$(printf '%s' "$out" | head -2)" ;; esac
fi

# ── the admin password never has to go on the command line (O rehearsal, finding 6) ──
H="$WORK/adm-env"; mkdir -p "$H"
out=$(MEMHOUSE_HOME="$H" MEMHOUSE_ADMIN_PASSWORD="$ADMPW" $CLI install --url "$URL" --admin-user "$ADM" --member im_envadm --member-password epw --yes --no-ship </dev/null 2>&1 || true)
case "$out" in *installed*) ok "install --admin-user takes the password from MEMHOUSE_ADMIN_PASSWORD (no flag, no TTY)" ;; *) bad "the env admin password was ignored" "$(printf '%s' "$out" | grep -E '✗' | head -2)" ;; esac
grep -q '^MEMHOUSE_ADMIN_PASSWORD' "$H/env" 2>/dev/null && bad "  the admin password was saved without --keep-admin" || ok "  and is not saved"
printf '%s' "$out" | grep -qF -- "$ADMPW" && bad "  the admin password was printed" || ok "  and never printed"
H="$WORK/adm-stdin"; mkdir -p "$H"
out=$(printf '%s\n' "$ADMPW" | MEMHOUSE_HOME="$H" $CLI install --url "$URL" --admin-user "$ADM" --admin-password-file - --member im_stdinadm --member-password spw --yes --no-ship 2>&1 || true)
case "$out" in *installed*) ok "--admin-password-file - reads it from stdin" ;; *) bad "the stdin admin password failed" "$(printf '%s' "$out" | grep -E '✗' | head -2)" ;; esac
H="$WORK/adm-keep"; mkdir -p "$H"
out=$(MEMHOUSE_HOME="$H" MEMHOUSE_ADMIN_PASSWORD="$ADMPW" $CLI install --url "$URL" --admin-user "$ADM" --member im_keepadm --member-password kpw --keep-admin --yes --no-ship </dev/null 2>&1 || true)
grep -q "^MEMHOUSE_ADMIN_USER='$ADM'" "$H/env" 2>/dev/null && ok "--keep-admin saves it — on request only" || bad "--keep-admin did not save it" "$(printf '%s' "$out" | tail -2)"
H="$WORK/adm-none"; mkdir -p "$H"
out=$(env -u MEMHOUSE_ADMIN_PASSWORD MEMHOUSE_HOME="$H" $CLI install --url "$URL" --admin-user "$ADM" --member im_noadm --member-password npw --yes --no-ship </dev/null 2>&1 || true)
case "$out" in *"no TTY to prompt on"*with-secret*) ok "no password anywhere: refused, naming the off-argv ways" ;; *) bad "a missing admin password was not explained" "$(printf '%s' "$out" | head -3)" ;; esac
H="$WORK/adm-stray"; mkdir -p "$H"
out=$(MEMHOUSE_HOME="$H" $CLI install --url "$URL" --user im_member --password mpw --keep-admin --yes --no-ship </dev/null 2>&1 || true)
case "$out" in *"only read with --admin-user"*) ok "--keep-admin on a member install is refused, not ignored" ;; *) bad "--keep-admin without --admin-user was not refused" "$(printf '%s' "$out" | head -2)" ;; esac

# ── cleanup ────────────────────────────────────────────────────────────────────────
for u in im_member im_target im_made im_occupy im_bare im_envadm im_stdinadm im_keepadm im_noadm; do
  q "DROP USER IF EXISTS $u" >/dev/null 2>&1 || true
  q "DROP DATABASE IF EXISTS $u SYNC" >/dev/null 2>&1 || true
  for t in $(q "SELECT name FROM system.tables WHERE database='mem' AND startsWith(name, '${u}_') FORMAT TSV" 2>/dev/null); do
    q "DROP TABLE IF EXISTS mem.$t SYNC" >/dev/null 2>&1 || true
  done
done

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
