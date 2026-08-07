#!/usr/bin/env bash
# sandbox/vm-e2e/run.sh — thin wrapper: resolves the agent-gauntlet engine and execs its
# run.sh with memhouse's subject params set. The engine (clone lifecycle, driver, assert,
# telemetry, dashboard) lives at github.com/agent-realm/agent-gauntlet.
#
# Usage: identical to the engine's run.sh — see `./run.sh --help`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # sandbox/vm-e2e
REPO="$(cd "$HERE/../.." && pwd)"                            # memhouse worktree root

: "${GAUNTLET_DIR:=$HOME/agent-realm/agent-gauntlet}"
if [ ! -x "$GAUNTLET_DIR/run.sh" ]; then
  echo "run.sh: agent-gauntlet engine not found at \$GAUNTLET_DIR ($GAUNTLET_DIR)." >&2
  echo "  clone it:  git clone https://github.com/agent-realm/agent-gauntlet \"$GAUNTLET_DIR\"" >&2
  exit 2
fi

export SUBJECT_DIR="${SUBJECT_DIR:-$REPO}"
export SUBJECT_REMOTE_DIR="${SUBJECT_REMOTE_DIR:-~/memhouse}"

# The house the assertions read.
#
# The engine's `sql-count:` grammar takes a literal URL and substitutes only __HOST__, so
# a config cannot name its endpoint from the environment. Hard-coding one in a committed
# config is how it rots: the address that was there yesterday is somebody else's service
# today. So the configs carry `__HOUSE__` and this wrapper renders them into a temporary
# CONFIGS_DIR at run time.
#
# MEMHOUSE_E2E_HOUSE must be reachable FROM THE CLONE, not from your workstation — the
# assertions run in-clone over ssh. A `lab` endpoint is `http://<LAB_IP>:<PORT_BASE>`;
# your local tunnel to it is not.
: "${MEMHOUSE_E2E_HOUSE:=}"
if [ -z "$MEMHOUSE_E2E_HOUSE" ] && grep -rqs '__HOUSE__' "$HERE/configs"; then
  echo "run.sh: set MEMHOUSE_E2E_HOUSE to the ClickHouse the CLONE can reach." >&2
  echo "  e.g. MEMHOUSE_E2E_HOUSE=http://10.10.10.30:18320 $0 …" >&2
  echo "  (a lab: LAB_IP + PORT_BASE, not localhost — the clone has no tunnel)" >&2
  exit 2
fi
export CONFIGS_DIR="${CONFIGS_DIR:-$HERE/configs}"

# Render into a temp dir AND rewrite any config path in the argv. The engine takes a
# config PATH as its first argument, so setting CONFIGS_DIR alone renders nothing that
# actually gets read — the dry-run still printed raw `__HOUSE__` in every assertion.
if [ -n "$MEMHOUSE_E2E_HOUSE" ]; then
  RENDERED="$(mktemp -d)"
  trap 'rm -rf "$RENDERED"' EXIT
  for f in "$CONFIGS_DIR"/*.toml; do
    [ -e "$f" ] || continue
    sed "s|__HOUSE__|$MEMHOUSE_E2E_HOUSE|g" "$f" > "$RENDERED/$(basename "$f")"
  done
  ARGS=()
  for a in "$@"; do
    case "$a" in
      *.toml) [ -e "$RENDERED/$(basename "$a")" ] && ARGS+=("$RENDERED/$(basename "$a")") || ARGS+=("$a") ;;
      *) ARGS+=("$a") ;;
    esac
  done
  set -- "${ARGS[@]}"
  export CONFIGS_DIR="$RENDERED"
fi
# Repo-local by default. The engine's own fallback is an absolute path inside one
# author's private notes directory, which does not exist on anyone else's machine —
# this repo is public, so it must not inherit it. Override for your own runs.
export ARTIFACTS_DIR="${ARTIFACTS_DIR:-$HERE/artifacts}"

exec "$GAUNTLET_DIR/run.sh" "$@"
