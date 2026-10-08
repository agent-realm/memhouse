#!/usr/bin/env bash
# Smoke test for the self-hosted team house: everything goes through the TLS proxy.
#
#   ./smoke.sh                  docker compose up -d with ./.env, then test it
#   SKIP_UP=1 ./smoke.sh        test a stack that is already running (see below)
#   KEEP=1 ./smoke.sh           keep the `smoke` member and its rooms afterwards
#
# With SKIP_UP=1 nothing is read from .env; give the target instead:
#   MEMHOUSE_URL              https://<domain>[:port]
#   MEMHOUSE_ADMIN_USER / MEMHOUSE_ADMIN_PASSWORD   (lend the password with with-secret)
#   CA_FILE                   the CA that signed the proxy's certificate, if not a public one
#
# What it proves: the proxy answers over TLS; the passwordless `default` user is gone; an
# admin can invite a member; the member installs, ships, and reads its rooms back; a
# BACKUP to the backups disk restores with the same row count.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MH=${MEMHOUSE_BIN:-memhouse}
mh() { $MH "$@"; }
WORK=$(mktemp -d)
unset MEMHOUSE_USER MEMHOUSE_PASSWORD MEMHOUSE_DB

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n        %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

if [ "${SKIP_UP:-0}" != "1" ]; then
  [ -f "$HERE/.env" ] || { echo "no .env — cp .env.example .env, fill it in, chmod 600"; exit 1; }
  (cd "$HERE" && docker compose up -d --wait)
  set -a; . "$HERE/.env"; set +a
  port=${MEMHOUSE_HTTPS_PORT:-443}
  MEMHOUSE_URL="https://$MEMHOUSE_DOMAIN$([ "$port" = 443 ] || echo ":$port")"
  MEMHOUSE_ADMIN_USER=${MEMHOUSE_ADMIN_USER:-admin}
  if [ "${MEMHOUSE_TLS:-internal}" = "internal" ]; then
    (cd "$HERE" && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/caddy-root.crt")
    CA_FILE="$WORK/caddy-root.crt"
  fi
fi
: "${MEMHOUSE_URL:?}" "${MEMHOUSE_ADMIN_USER:?}" "${MEMHOUSE_ADMIN_PASSWORD:?}"
export MEMHOUSE_URL MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD
CURL=(curl -sS)
if [ -n "${CA_FILE:-}" ]; then
  CURL+=(--cacert "$CA_FILE")
  export NODE_EXTRA_CA_CERTS="$CA_FILE"   # memhouse is Node: it trusts this CA too
fi

# Passwords go to curl on stdin (-K -), never on its command line.
q_as() { printf 'user = "%s:%s"\n' "$1" "$2" | "${CURL[@]}" -K - --data-binary "$3" "$MEMHOUSE_URL/" 2>&1; }
admin_q() { q_as "$MEMHOUSE_ADMIN_USER" "$MEMHOUSE_ADMIN_PASSWORD" "$1"; }
member_q() { ( set -a; . "$WORK/home/env"; set +a; q_as "$MEMHOUSE_USER" "$MEMHOUSE_PASSWORD" "$1" ); }

cleanup() {
  if [ "${KEEP:-0}" != "1" ] && [ "${CREATED:-0}" = "1" ]; then
    admin_q "DROP USER IF EXISTS smoke" >/dev/null || true
    for t in $(admin_q "SELECT name FROM system.tables WHERE database = 'mem' AND startsWith(name, 'smoke_') FORMAT TSV"); do
      admin_q "DROP TABLE IF EXISTS mem.$t SYNC" >/dev/null || true
    done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "smoke test against $MEMHOUSE_URL"

r=$("${CURL[@]}" "$MEMHOUSE_URL/ping" 2>&1 || true)
[ "$r" = "Ok." ] && ok "the proxy answers over TLS (certificate verified)" || bad "no TLS answer from the proxy" "$r"

r=$(q_as default "" "SELECT 1" || true)
case "$r" in *AUTHENTICATION_FAILED*|*"Authentication failed"*|*REQUIRED_PASSWORD*) ok "the passwordless default user is gone";; *) bad "the default user still answers" "$r";; esac

r=$(admin_q "SELECT version()")
case "$r" in [0-9]*) ok "admin reaches ClickHouse $r";; *) bad "admin login failed" "$r"; exit 1;; esac

n=$(admin_q "SELECT count() FROM system.users WHERE name = 'smoke' FORMAT TSV")
[ "$n" = "0" ] || { bad "a user named smoke already exists — refusing to touch it"; exit 1; }
CREATED=1

# A loopback URL is right only through a tunnel; invite refuses one unless told so.
case "$MEMHOUSE_URL" in https://localhost*|https://127.0.0.1*) LOCAL=--allow-local;; *) LOCAL=;; esac
export MEMHOUSE_HOME="$WORK/admin"; mkdir -p "$MEMHOUSE_HOME"
out=$(cd "$WORK" && mh invite smoke --url "$MEMHOUSE_URL" --admin-user "$MEMHOUSE_ADMIN_USER" --out "$WORK/smoke.env" $LOCAL 2>&1 || true)
case "$out" in *"invite written"*) ok "admin invited member 'smoke'";; *) bad "invite failed" "$(printf '%s' "$out" | tail -3)"; exit 1;; esac

export MEMHOUSE_HOME="$WORK/home"; mkdir -p "$MEMHOUSE_HOME"
node "$HERE/../fixtures/make-sessions.js" "$WORK/sessions" smoke alpha beta >/dev/null
out=$(unset MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD
      mh install --env "$WORK/smoke.env" --editors claude --claude-roots "$WORK/sessions" --yes --no-ship 2>&1 || true)
case "$out" in *"installed"*) ok "the member installed from the invite file, over https";; *) bad "install failed" "$(printf '%s' "$out" | grep '✗' | head -3)"; exit 1;; esac
out=$(unset MEMHOUSE_ADMIN_USER MEMHOUSE_ADMIN_PASSWORD; mh ship 2>&1 || true)
case "$out" in *"shipped 2 sessions"*) ok "shipped: $(printf '%s' "$out" | tail -1 | sed 's/^\[memhouse\] //')";; *) bad "ship failed" "$out";; esac

r=$(member_q "SELECT count() FROM mem.smoke_messages FINAL FORMAT TSV")
[ "$r" = "6" ] && ok "the member reads its 6 messages back through the proxy" || bad "read-back count" "$r"
r=$(member_q "CREATE TABLE mem.not_mine (x UInt8) ENGINE = MergeTree ORDER BY x" || true)
case "$r" in *ACCESS_DENIED*|*"Not enough privileges"*) ok "the member cannot create tables outside mem.smoke_*";; *) bad "the member created a table outside its rooms" "$r";; esac

ts=$(date -u +%Y-%m-%d-%H_%M_%S)
r=$(admin_q "BACKUP TABLE mem.smoke_messages TO Disk('backups', 'mem-smoke-$ts.zip')")
case "$r" in *BACKUP_CREATED*) ok "BACKUP to the backups disk";; *) bad "backup failed" "$r";; esac
r=$(admin_q "RESTORE TABLE mem.smoke_messages AS mem.smoke_restore_check FROM Disk('backups', 'mem-smoke-$ts.zip')")
case "$r" in *RESTORED*) ok "RESTORE from it";; *) bad "restore failed" "$r";; esac
r=$(admin_q "SELECT count() FROM mem.smoke_restore_check FORMAT TSV")
[ "$r" = "6" ] && ok "the restored copy holds the same 6 rows" || bad "restored count" "$r"

r=$(admin_q "SELECT status FROM system.backups WHERE name LIKE '%''mem-2%' AND startsWith(toString(status), 'BACKUP') ORDER BY start_time DESC LIMIT 1 FORMAT TSV")
case "$r" in BACKUP_CREATED) ok "the backup service has written a nightly backup since the server started";;
  '') printf '  info  no nightly backup yet this server lifetime (BACKUP_ON_START=1 runs one at start)\n';;
  *) bad "the last nightly backup did not complete" "$r";; esac

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
