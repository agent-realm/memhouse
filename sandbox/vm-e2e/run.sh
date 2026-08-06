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
export CONFIGS_DIR="${CONFIGS_DIR:-$HERE/configs}"
# Repo-local by default. The engine's own fallback is an absolute path inside one
# author's private notes directory, which does not exist on anyone else's machine —
# this repo is public, so it must not inherit it. Override for your own runs.
export ARTIFACTS_DIR="${ARTIFACTS_DIR:-$HERE/artifacts}"

exec "$GAUNTLET_DIR/run.sh" "$@"
