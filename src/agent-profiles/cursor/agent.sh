#!/bin/bash
# Cursor CLI agent script — runs the Cursor `agent` with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the cursor agent profile. Selected via --agent cursor.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (release-readiness/X-08-P7/P8).
#
# CLI reference:    https://cursor.com/docs/cli/using
# Headless docs:   https://cursor.com/docs/cli/headless
# Auth docs:       https://cursor.com/docs/cli/reference/authentication
#
# Authentication:
#   CURSOR_API_KEY is the headless auth path. The factory provides LLM_API_KEY as
#   the generic credential; we map it to CURSOR_API_KEY as a fallback inside the
#   runuser shell. CURSOR_API_KEY takes precedence if already set (via
#   --agent-secret CURSOR_API_KEY).
#
# Model: LLM_MODEL_ID → --model. Cursor uses its own model identifiers (not
# provider/model strings). LLM_BASE_URL is not supported.
#
# Key flags:
#   -p / --print              Non-interactive mode.
#   --force / --yolo          Allow file edits without confirmation (required headlessly).
#   --trust                   Trust the workspace without prompting (required headlessly).
#   --output-format stream-json  Newline-delimited JSON events.

set -euo pipefail

echo "[agent/cursor] Starting agent cursor in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/cursor] About to run (as ${SAIFCTL_UNPRIV_USER}): agent -p --force --trust ${LLM_MODEL_ID:+--model ${LLM_MODEL_ID} }--output-format stream-json -- \"${_SAIFCTL_TASK_SNIP}\" (CURSOR_API_KEY from env, masked as ****)"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist),CURSOR_API_KEY" \
  -c '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export CURSOR_API_KEY="${CURSOR_API_KEY:-${LLM_API_KEY:-}}"
    _model_flag=()
    if [ -n "${LLM_MODEL_ID:-}" ]; then
      _model_flag=(--model "$LLM_MODEL_ID")
    fi
    agent \
      -p \
      --force \
      --trust \
      "${_model_flag[@]}" \
      --output-format stream-json \
      -- \
      "$(cat "$SAIFCTL_TASK_PATH")"
  ' < /dev/null || _agent_exit=$?

echo "[agent/cursor] Finished agent cursor in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
