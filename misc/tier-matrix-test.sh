#!/usr/bin/env bash
# Walks the tier/ownership matrix and asserts the invariants that seven rounds of review
# turned up one corner at a time. Every case here corresponds to a defect that was real:
# the point is that the next change gets checked against all of them at once instead of
# whichever corner someone happens to think of.
#
# Needs: Linux, podman or docker, a writable /tmp. Touches nothing outside the temp homes
# it creates and the memhouse-named container/volume, and removes all of it on exit.
# NOT run by `npm test` — it starts containers and takes a few minutes.
#
#   ./misc/tier-matrix-test.sh
#
# systemd cases are skipped when there is no user manager (`systemctl --user` unusable),
# which is normal in a container. They are reported as skipped, never as passed.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CLI="node $REPO/bin/memhouse.js"
TMP="$(mktemp -d /tmp/memhouse-matrix.XXXXXX)"
PORT_CH=18123
PORT_SOLO=18124
PASS=0 FAIL=0 SKIP=0

ok()   { echo "  ok    $*"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
skip() { echo "  skip  $*"; SKIP=$((SKIP+1)); }
say()  { echo; echo "== $*"; }

# assert <description> <expected-exit> <command...>
assert_exit() {
  local desc="$1" want="$2"; shift 2
  "$@" >"$TMP/out" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc (exit $got, wanted $want)"; sed 's/^/        /' "$TMP/out" | tail -4; fi
}
# assert_out <description> <regex> <command...>
assert_out() {
  local desc="$1" re="$2"; shift 2
  "$@" >"$TMP/out" 2>&1
  if grep -qE "$re" "$TMP/out"; then ok "$desc"; else bad "$desc (no match for /$re/)"; sed 's/^/        /' "$TMP/out" | tail -4; fi
}

have_systemd() { systemctl --user show-environment >/dev/null 2>&1; }

cleanup() {
  for h in "$TMP"/home-*; do [ -d "$h" ] && MEMHOUSE_HOME="$h" $CLI uninstall >/dev/null 2>&1; done
  MEMHOUSE_HOME="$TMP/home-x" $CLI service uninstall >/dev/null 2>&1
  pkill -f "$REPO/mem-house/solo/server.js" >/dev/null 2>&1
  local eng; eng=$(command -v podman || command -v docker) || true
  if [ -n "${eng:-}" ]; then "$eng" rm -f memhouse-clickhouse >/dev/null 2>&1; "$eng" volume rm -f memhouse-data >/dev/null 2>&1; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

command -v podman >/dev/null 2>&1 || command -v docker >/dev/null 2>&1 || { echo "no container engine — nothing to test"; exit 2; }

say "solo tier: deploy, restart cycle, teardown"
H="$TMP/home-solo"; mkdir -p "$H"; export MEMHOUSE_HOME="$H"
export MEMHOUSE_SOLO_DATA="$TMP/solo-data"
assert_exit "deploy --solo" 0 env MEMHOUSE_HOME="$H" $CLI deploy --solo --house-port $PORT_SOLO --no-ship
assert_out  "solo is persisted, not inferred" "MEMHOUSE_SOLO='1'" cat "$H/env"
assert_exit "stop" 0 env MEMHOUSE_HOME="$H" $CLI stop
# The bug this guards: `stop` removes the pidfile, so a pidfile-derived tier lost the shim.
assert_out  "start brings the shim back" "solo house answering" env MEMHOUSE_HOME="$H" $CLI start
assert_out  "status sees the house" "connected:" env MEMHOUSE_HOME="$H" $CLI status
env MEMHOUSE_HOME="$H" $CLI stop >/dev/null 2>&1

say "solo tier: a redeploy must find the existing house, not relocate it"
assert_out  "bare redeploy reuses the persisted port" "$PORT_SOLO" env MEMHOUSE_HOME="$H" $CLI deploy --solo --no-ship
assert_out  "an explicit new port MOVES the shim" "moving it to $((PORT_SOLO+1))" env MEMHOUSE_HOME="$H" $CLI deploy --solo --house-port $((PORT_SOLO+1)) --no-ship
env MEMHOUSE_HOME="$H" $CLI stop >/dev/null 2>&1

say "per-member: install must not create the shared schema"
H2="$TMP/home-pm"; mkdir -p "$H2"
# No server needed: it must refuse before it can even resolve rooms.
assert_out "install --per-member fails closed without a house" "connection failed|has no |could not" \
  env MEMHOUSE_HOME="$H2" MEM_PER_MEMBER=1 $CLI install --yes --url http://127.0.0.1:1 --user u --password p --db mem --no-ship
assert_out "ship --ensure-schema refuses under MEM_PER_MEMBER" "provision.js --member" \
  env MEM_PER_MEMBER=1 MEMHOUSE_URL=http://127.0.0.1:1 node "$REPO/mem-house/shipper/ship.js" --ensure-schema

say "solo + per-member is refused, not half-applied"
assert_exit "deploy --solo with MEM_PER_MEMBER=1" 2 \
  env MEMHOUSE_HOME="$TMP/home-mix" MEM_PER_MEMBER=1 $CLI deploy --solo --no-ship

say "local tier: credential survives a redeploy"
H3="$TMP/home-local"; mkdir -p "$H3"
assert_exit "deploy --local" 0 env MEMHOUSE_HOME="$H3" $CLI deploy --local --house-port $PORT_CH --no-ship
PW1=$(grep MEMHOUSE_PASSWORD "$H3/env" 2>/dev/null)
assert_out  "redeploy reuses the house credential" "reusing the existing house credential" \
  env MEMHOUSE_HOME="$H3" $CLI deploy --local --house-port $PORT_CH --no-ship
PW2=$(grep MEMHOUSE_PASSWORD "$H3/env" 2>/dev/null)
[ "$PW1" = "$PW2" ] && ok "credential unchanged across redeploy" || bad "credential changed — the CLI would be locked out"
assert_exit "rotating against an initialised volume is refused" 2 \
  env MEMHOUSE_HOME="$H3" $CLI deploy --local --house-port $PORT_CH --no-ship --rotate-password
assert_out  "status still authenticates" "connected:" env MEMHOUSE_HOME="$H3" $CLI status

say "ownership: memhouse refuses to touch what it did not create"
ENG=$(command -v podman || command -v docker)
env MEMHOUSE_HOME="$H3" $CLI deploy --down >/dev/null 2>&1
"$ENG" volume create memhouse-data >/dev/null 2>&1
"$ENG" run -d --name memhouse-clickhouse docker.io/library/busybox:latest sleep 300 >/dev/null 2>&1
assert_out "deploy --down refuses a foreign container" "not created by memhouse" env MEMHOUSE_HOME="$H3" $CLI deploy --down
assert_out "deploy --local refuses a foreign container" "not created by memhouse" env MEMHOUSE_HOME="$H3" $CLI deploy --local --no-ship
"$ENG" rm -f memhouse-clickhouse >/dev/null 2>&1; "$ENG" volume rm -f memhouse-data >/dev/null 2>&1
ok "foreign container and volume survived both commands"

say "tier switch: solo then local, on the port they both want"
H4="$TMP/home-switch"; mkdir -p "$H4"
env MEMHOUSE_HOME="$H4" MEMHOUSE_SOLO_DATA="$TMP/switch-data" $CLI deploy --solo --house-port $PORT_CH --no-ship >/dev/null 2>&1
assert_out "local stops the managed shim first" "stopping the solo house" \
  env MEMHOUSE_HOME="$H4" $CLI deploy --local --house-port $PORT_CH --no-ship
assert_out "and clears the solo flag" "MEMHOUSE_SOLO='0'" cat "$H4/env"
env MEMHOUSE_HOME="$H4" $CLI deploy --down >/dev/null 2>&1

say "lockout guards: every way of asking for a different credential"
H6="$TMP/home-lock"; mkdir -p "$H6"
env MEMHOUSE_HOME="$H6" $CLI deploy --local --house-port $PORT_CH --no-ship >/dev/null 2>&1
assert_exit "--password on an initialised volume is refused" 2 \
  env MEMHOUSE_HOME="$H6" $CLI deploy --local --house-port $PORT_CH --no-ship --password whatever
assert_exit "MEMHOUSE_PASSWORD on an initialised volume is refused" 2 \
  env MEMHOUSE_HOME="$H6" MEMHOUSE_PASSWORD=whatever $CLI deploy --local --house-port $PORT_CH --no-ship
assert_out "the credential still works after the refusals" "connected:" env MEMHOUSE_HOME="$H6" $CLI status
# A refusal must not have killed the daemons on its way to refusing.
env MEMHOUSE_HOME="$H6" $CLI start >/dev/null 2>&1; sleep 1
env MEMHOUSE_HOME="$H6" $CLI deploy --local --house-port $PORT_CH --no-ship --rotate-password >/dev/null 2>&1
if [ -e "$H6/run/shipper.pid" ]; then ok "a refused redeploy leaves the daemons alone"; else bad "a refused redeploy killed the shipper"; fi
env MEMHOUSE_HOME="$H6" $CLI stop >/dev/null 2>&1

say "a bare redeploy keeps the house where it is"
assert_out "persisted port is reused without the flag" "localhost:$PORT_CH" \
  env MEMHOUSE_HOME="$H6" $CLI deploy --local --no-ship
env MEMHOUSE_HOME="$H6" $CLI deploy --down >/dev/null 2>&1

say "solo must not adopt somebody else's ClickHouse"
H7="$TMP/home-adopt"; mkdir -p "$H7"
env MEMHOUSE_HOME="$H7" $CLI deploy --local --house-port $PORT_CH --no-ship >/dev/null 2>&1
PWL=$(grep MEMHOUSE_PASSWORD "$H7/env" 2>/dev/null)
assert_exit "deploy --solo onto the local house's port is refused" 2 \
  env MEMHOUSE_HOME="$H7" MEMHOUSE_SOLO_DATA="$TMP/adopt-data" $CLI deploy --solo --house-port $PORT_CH --no-ship
PWL2=$(grep MEMHOUSE_PASSWORD "$H7/env" 2>/dev/null)
[ "$PWL" = "$PWL2" ] && ok "the local credential was not overwritten" || bad "credential overwritten — the CLI is locked out"
env MEMHOUSE_HOME="$H7" $CLI deploy --down >/dev/null 2>&1

say "preflight: a refusal must not cost you a running pipeline"
H8="$TMP/home-pre"; mkdir -p "$H8"
env MEMHOUSE_HOME="$H8" $CLI deploy --local --house-port $PORT_CH --no-ship >/dev/null 2>&1
env MEMHOUSE_HOME="$H8" $CLI start >/dev/null 2>&1; sleep 1
# Make the fixed names foreign, so the ownership check must refuse.
env MEMHOUSE_HOME="$H8" $CLI deploy --down >/dev/null 2>&1
"$ENG" run -d --name memhouse-clickhouse docker.io/library/busybox:latest sleep 300 >/dev/null 2>&1
assert_out "a foreign container is refused" "not created by memhouse" env MEMHOUSE_HOME="$H8" $CLI deploy --local --no-ship
if [ -e "$H8/run/dashboard.pid" ]; then ok "the refusal left the dashboard running"; else bad "the refusal killed the dashboard first"; fi
"$ENG" rm -f memhouse-clickhouse >/dev/null 2>&1
env MEMHOUSE_HOME="$H8" $CLI stop >/dev/null 2>&1

say "solo: an occupied target port is rejected before the old shim dies"
H9="$TMP/home-move"; mkdir -p "$H9"
env MEMHOUSE_HOME="$H9" MEMHOUSE_SOLO_DATA="$TMP/move-data" $CLI deploy --solo --house-port $PORT_SOLO --no-ship >/dev/null 2>&1
# Occupy the destination with something that is not us.
python3 -c "import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',$((PORT_SOLO+5))));s.listen(1);time.sleep(30)" &
BLOCKER=$!; sleep 1
assert_exit "moving onto an occupied port is refused" 2 \
  env MEMHOUSE_HOME="$H9" $CLI deploy --solo --house-port $((PORT_SOLO+5)) --no-ship
assert_out "and the original house is still serving" "connected:" env MEMHOUSE_HOME="$H9" $CLI status
kill $BLOCKER 2>/dev/null
env MEMHOUSE_HOME="$H9" $CLI stop >/dev/null 2>&1

say "service integration"
if ! have_systemd; then
  skip "no usable systemctl --user on this host (normal in a container)"
else
  H5="$TMP/home-svc"; mkdir -p "$H5"
  env MEMHOUSE_HOME="$H5" MEMHOUSE_SOLO_DATA="$TMP/svc-data" $CLI deploy --solo --house-port $((PORT_SOLO+2)) --no-ship >/dev/null 2>&1
  assert_out "service install takes over the pidfile daemons" "solo house service installed" \
    env MEMHOUSE_HOME="$H5" MEMHOUSE_SOLO_DATA="$TMP/svc-data" $CLI service install
  sleep 3
  assert_out "status reports the service-managed shipper" "shipper: running — service" env MEMHOUSE_HOME="$H5" $CLI status
  assert_out "start does not spawn a second shipper" "shipper is service-managed" env MEMHOUSE_HOME="$H5" $CLI start
  assert_out "nor a second shim" "solo is service-managed" env MEMHOUSE_HOME="$H5" $CLI start
  assert_exit "a service-managed port change is refused" 2 \
    env MEMHOUSE_HOME="$H5" $CLI deploy --solo --house-port $((PORT_SOLO+3)) --no-ship
  assert_exit "a service-managed tier switch is refused" 2 \
    env MEMHOUSE_HOME="$H5" $CLI deploy --local --house-port $PORT_CH --no-ship
  assert_out "uninstall removes the service too" "service removed" env MEMHOUSE_HOME="$H5" $CLI uninstall
  [ -e "$HOME/.config/systemd/user/memhouse-shipper.service" ] && bad "unit file survived uninstall" || ok "unit files removed"
fi

echo
echo "matrix: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
