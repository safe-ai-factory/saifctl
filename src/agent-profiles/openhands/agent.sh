#!/bin/bash
# OpenHands agent script — invokes OpenHands with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the openhands agent profile. Selected via --agent openhands (default).
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (X08-P7/P8).
#
# CLI reference: https://docs.openhands.dev/openhands/usage/cli/command-reference
#
# Model and API key:
#   OpenHands natively uses LLM_MODEL, LLM_API_KEY, and LLM_BASE_URL — the same
#   variable names the factory provides. No mapping needed.
#   --override-with-envs applies these env vars to override stored settings.
#
# Key flags:
#   --headless         Run without UI (required for automation).
#   --always-approve   Auto-approve all actions without confirmation.
#   --override-with-envs  Apply LLM_MODEL, LLM_API_KEY, LLM_BASE_URL from environment.
#   --json             JSONL output; parsed by the factory's openhands log formatter.
#   -t                 Task string to execute.

set -euo pipefail

echo "[agent/openhands] Starting agent openhands in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/openhands] About to run (as ${SAIFCTL_UNPRIV_USER}): openhands --headless --always-approve --override-with-envs --json -t \"${_SAIFCTL_TASK_SNIP}\""

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist),OPENHANDS_WORK_DIR" \
  -c '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export OPENHANDS_WORK_DIR="${OPENHANDS_WORK_DIR:-/tmp/openhands-state}"
    openhands --headless --always-approve --override-with-envs --json -t "$(cat "$SAIFCTL_TASK_PATH")"
  ' < /dev/null || _agent_exit=$?

echo "[agent/openhands] Finished agent openhands in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
