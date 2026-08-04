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
  local eng; eng=$(command -v podman || command -v docker) || true
  if [ -n "${eng:-}" ]; then "$eng" rm -f memhouse-clickhouse >/dev/null 2>&1; "$eng" volume rm -f memhouse-data >/dev/null 2>&1; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

command -v podman >/dev/null 2>&1 || command -v docker >/dev/null 2>&1 || { echo "no container engine — nothing to test"; exit 2; }

say "per-member: install must not create the shared schema"
H2="$TMP/home-pm"; mkdir -p "$H2"
# No server needed: it must refuse before it can even resolve rooms.
assert_out "install --per-member fails closed without a house" "connection failed|has no |could not" \
  env MEMHOUSE_HOME="$H2" MEM_PER_MEMBER=1 $CLI install --yes --url http://127.0.0.1:1 --user u --password p --db mem --no-ship
assert_out "ship --ensure-schema refuses under MEM_PER_MEMBER" "provision.js --member" \
  env MEM_PER_MEMBER=1 MEMHOUSE_URL=http://127.0.0.1:1 node "$REPO/mem-house/shipper/ship.js" --ensure-schema

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

say "moving the house has two guards: an occupied target and a service that cannot see it"
HA="$TMP/home-lmove"; mkdir -p "$HA"
env MEMHOUSE_HOME="$HA" $CLI deploy --local --house-port $PORT_CH --no-ship >/dev/null 2>&1
python3 -c "import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',$((PORT_CH+7))));s.listen(1);time.sleep(30)" &
BLOCKER2=$!; sleep 1
assert_exit "moving the house onto an occupied port is refused" 2 \
  env MEMHOUSE_HOME="$HA" $CLI deploy --local --house-port $((PORT_CH+7)) --no-ship
assert_out "and the house is still where it was" "connected:" env MEMHOUSE_HOME="$HA" $CLI status
kill $BLOCKER2 2>/dev/null
if have_systemd; then
  env MEMHOUSE_HOME="$HA" $CLI service install >/dev/null 2>&1; sleep 2
  assert_exit "moving it under a service-managed shipper is refused" 2 \
    env MEMHOUSE_HOME="$HA" $CLI deploy --local --house-port $((PORT_CH+8)) --no-ship
  env MEMHOUSE_HOME="$HA" $CLI service uninstall >/dev/null 2>&1
else
  skip "service-managed local move (no user manager)"
fi
env MEMHOUSE_HOME="$HA" $CLI deploy --down >/dev/null 2>&1

say "a generated credential survives the CLI dying mid-startup"
HD="$TMP/home-crash"; mkdir -p "$HD"
( env MEMHOUSE_HOME="$HD" $CLI deploy --local --house-port $((PORT_CH+3)) --no-ship >/dev/null 2>&1 & echo $! > "$TMP/crash.pid" )
sleep 4; kill "$(cat "$TMP/crash.pid")" 2>/dev/null; sleep 1
if grep -q MEMHOUSE_PASSWORD "$HD/env" 2>/dev/null; then ok "credential persisted before readiness"
else bad "credential lost with the process — the volume is initialised and unreachable"; fi
sleep 12
assert_out "the redeploy reuses it instead of refusing" "reusing the existing house credential" \
  env MEMHOUSE_HOME="$HD" $CLI deploy --local --house-port $((PORT_CH+3)) --no-ship
assert_out "and it authenticates" "connected:" env MEMHOUSE_HOME="$HD" $CLI status
env MEMHOUSE_HOME="$HD" $CLI deploy --down >/dev/null 2>&1

say "a failed run must not leave a false 'initialised house' marker"
HE="$TMP/home-badtag"; mkdir -p "$HE"
env MEMHOUSE_HOME="$HE" $CLI deploy --local --house-port $((PORT_CH+4)) --tag no-such-tag-9999 --no-ship >/dev/null 2>&1
VOLS=$("$ENG" volume ls -q | grep -c memhouse-data || true)
[ "$VOLS" = "0" ] && ok "no orphan volume after a failed run" || bad "an empty labelled volume survived — the next deploy will refuse"
assert_out "and a retry succeeds instead of refusing" "installed" \
  env MEMHOUSE_HOME="$HE" $CLI deploy --local --house-port $((PORT_CH+4)) --no-ship
env MEMHOUSE_HOME="$HE" $CLI deploy --down >/dev/null 2>&1

say "a bad tag must not take down a working house"
HF="$TMP/home-tag"; mkdir -p "$HF"
env MEMHOUSE_HOME="$HF" $CLI deploy --local --house-port $((PORT_CH+5)) --no-ship >/dev/null 2>&1
assert_out "an unobtainable tag is refused before the removal" "existing house was left running" \
  env MEMHOUSE_HOME="$HF" $CLI deploy --local --house-port $((PORT_CH+5)) --tag no-such-tag-1234 --no-ship
assert_out "and the house is still serving" "connected:" env MEMHOUSE_HOME="$HF" $CLI status
env MEMHOUSE_HOME="$HF" $CLI deploy --down >/dev/null 2>&1

say "a bad tag is caught before anything is stopped"
HI="$TMP/home-tag2"; mkdir -p "$HI"
env MEMHOUSE_HOME="$HI" $CLI deploy --local --house-port $((PORT_CH+9)) --no-ship >/dev/null 2>&1
env MEMHOUSE_HOME="$HI" $CLI start >/dev/null 2>&1; sleep 2
env MEMHOUSE_HOME="$HI" $CLI deploy --local --house-port $((PORT_CH+9)) --tag no-such-tag-77 --no-ship >/dev/null 2>&1
if [ -e "$HI/run/shipper.pid" ] && [ -e "$HI/run/dashboard.pid" ]; then
  ok "the refusal left both clients running"
else bad "the clients were stopped before the image was validated"; fi
assert_out "and the house is still serving" "connected:" env MEMHOUSE_HOME="$HI" $CLI status
env MEMHOUSE_HOME="$HI" $CLI stop >/dev/null 2>&1
env MEMHOUSE_HOME="$HI" $CLI deploy --down >/dev/null 2>&1

say "a foreign container beside a MANAGED volume is still a local house"
HN="$TMP/home-mixed"; mkdir -p "$HN"
env MEMHOUSE_HOME="$HN" $CLI deploy --local --house-port $((PORT_CH+13)) --no-ship >/dev/null 2>&1
PWN=$(grep MEMHOUSE_PASSWORD "$HN/env" 2>/dev/null)
"$ENG" rm -f memhouse-clickhouse >/dev/null 2>&1                       # leave the managed VOLUME
"$ENG" run -d --name memhouse-clickhouse docker.io/library/busybox:latest sleep 300 >/dev/null 2>&1
assert_out "the foreign container is refused, not replaced" "not created by memhouse" \
  env MEMHOUSE_HOME="$HN" $CLI deploy --local --house-port $((PORT_CH+13)) --no-ship
PWN2=$(grep MEMHOUSE_PASSWORD "$HN/env" 2>/dev/null)
[ "$PWN" = "$PWN2" ] && ok "the managed volume's credential survived" || bad "credential overwritten — that volume is unreachable"
"$ENG" rm -f memhouse-clickhouse >/dev/null 2>&1; "$ENG" volume rm -f memhouse-data >/dev/null 2>&1

say "teardown must not orphan a shipper service"
if ! have_systemd; then
  skip "deploy --down with a service installed (no user manager)"
else
  HP="$TMP/home-orphan"; mkdir -p "$HP"
  env MEMHOUSE_HOME="$HP" $CLI deploy --local --house-port $((PORT_CH+14)) --no-ship >/dev/null 2>&1
  env MEMHOUSE_HOME="$HP" $CLI service install >/dev/null 2>&1; sleep 2
  assert_exit "deploy --down is refused while the service is installed" 2 \
    env MEMHOUSE_HOME="$HP" $CLI deploy --down
  env MEMHOUSE_HOME="$HP" $CLI service uninstall >/dev/null 2>&1
  assert_exit "and works once it is uninstalled" 0 env MEMHOUSE_HOME="$HP" $CLI deploy --down
fi

say "the move guards read the effective port, not just the flag"
HQ="$TMP/home-envport"; mkdir -p "$HQ"
env MEMHOUSE_HOME="$HQ" $CLI deploy --local --house-port $((PORT_CH+15)) --no-ship >/dev/null 2>&1
python3 -c "import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',$((PORT_CH+16))));s.listen(1);time.sleep(40)" &
BLOCK3=$!; sleep 1
assert_exit "MEMHOUSE_CH_PORT onto an occupied port is refused" 2 \
  env MEMHOUSE_CH_PORT=$((PORT_CH+16)) MEMHOUSE_HOME="$HQ" $CLI deploy --local --no-ship
assert_out "and the house is still where it was" "connected:" env MEMHOUSE_HOME="$HQ" $CLI status
kill $BLOCK3 2>/dev/null
env MEMHOUSE_HOME="$HQ" $CLI deploy --down >/dev/null 2>&1

say "teardown ignores a service that points somewhere else"
if ! have_systemd; then
  skip "unrelated-service teardown (no user manager)"
else
  # Order matters: the local house must exist BEFORE the unrelated service is installed.
  # Deploying it afterwards is now correctly refused — a service pointing elsewhere blocks
  # any deploy that would repoint the config — so building the fixture the other way round
  # tests nothing.
  HS="$TMP/home-localside"; mkdir -p "$HS"
  env MEMHOUSE_HOME="$HS" $CLI deploy --local --house-port $((PORT_CH+17)) --no-ship >/dev/null 2>&1
  # A service pointing at an EXTERNAL house — nothing to do with the managed container.
  HR="$TMP/home-otherservice"; mkdir -p "$HR"
  env MEMHOUSE_HOME="$HR" $CLI setup --yes --url http://127.0.0.1:$((PORT_CH+90)) --user u --password p --db memhouse >/dev/null 2>&1
  env MEMHOUSE_HOME="$HR" $CLI service install >/dev/null 2>&1; sleep 2
  assert_exit "an unrelated service does not block teardown" 0 env MEMHOUSE_HOME="$HS" $CLI deploy --down
  env MEMHOUSE_HOME="$HR" $CLI uninstall >/dev/null 2>&1
fi

say "service integration"
if ! have_systemd; then
  skip "no usable systemctl --user on this host (normal in a container)"
else
  H5="$TMP/home-svc"; mkdir -p "$H5"
  env MEMHOUSE_HOME="$H5" $CLI deploy --local --house-port $((PORT_CH+18)) --no-ship >/dev/null 2>&1
  assert_out "service install takes over the pidfile daemon" "service installed" \
    env MEMHOUSE_HOME="$H5" $CLI service install
  sleep 3
  assert_out "status reports the service-managed shipper" "shipper: running — service" env MEMHOUSE_HOME="$H5" $CLI status
  assert_out "start does not spawn a second shipper" "shipper is service-managed" env MEMHOUSE_HOME="$H5" $CLI start
  assert_exit "a service-managed port change is refused" 2 \
    env MEMHOUSE_HOME="$H5" $CLI deploy --local --house-port $((PORT_CH+19)) --no-ship
  assert_out "uninstall removes the service too" "service removed" env MEMHOUSE_HOME="$H5" $CLI uninstall
  [ -e "$HOME/.config/systemd/user/memhouse-shipper.service" ] && bad "unit file survived uninstall" || ok "unit files removed"
fi

echo
echo "matrix: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
