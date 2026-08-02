#!/usr/bin/env bash
# sandbox/vm-e2e/run.sh — thin wrapper: resolves the agent-gauntlet engine and execs its
# run.sh with memhouse's subject params set. The engine (clone lifecycle, driver, assert,
# telemetry, dashboard) lives at github.com/ramazanpolat/agent-gauntlet.
#
# Usage: identical to the engine's run.sh — see `./run.sh --help`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # sandbox/vm-e2e
REPO="$(cd "$HERE/../.." && pwd)"                            # memhouse worktree root

: "${GAUNTLET_DIR:=$HOME/DEV/agent-gauntlet}"
if [ ! -x "$GAUNTLET_DIR/run.sh" ]; then
  echo "run.sh: agent-gauntlet engine not found at \$GAUNTLET_DIR ($GAUNTLET_DIR)." >&2
  echo "  clone it:  git clone https://github.com/ramazanpolat/agent-gauntlet \"$GAUNTLET_DIR\"" >&2
  exit 2
fi

export SUBJECT_DIR="${SUBJECT_DIR:-$REPO}"
export SUBJECT_REMOTE_DIR="${SUBJECT_REMOTE_DIR:-~/memhouse}"
export CONFIGS_DIR="${CONFIGS_DIR:-$HERE/configs}"
export ARTIFACTS_DIR="${ARTIFACTS_DIR:-/Users/polat/.claude-playbooks/kommander/data/tasks/memhouse/artifacts}"

exec "$GAUNTLET_DIR/run.sh" "$@"
