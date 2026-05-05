#!/bin/bash
# Gemini CLI agent script — runs Gemini with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the gemini agent profile. Selected via --agent gemini.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference: https://geminicli.com/docs/reference/configuration/#command-line-arguments
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (X08-P7/P8).
#
# Model and API key:
#   Gemini expects GEMINI_API_KEY. The factory provides LLM_API_KEY (generic) and
#   LLM_MODEL_ID (bare model id; LLM_MODEL is the prefixed `provider/model` form
#   for LiteLLM-style agents and would be rejected by Gemini's CLI). We fall
#   back to LLM_API_KEY when GEMINI_API_KEY is not set, and pass LLM_MODEL_ID
#   via --model to override Gemini's default.
#
#   Note: Gemini CLI does not currently support a base URL override via env var;
#   LLM_BASE_URL is not forwarded.
#
# Key flags:
#   <prompt>                   Positional: invoking with a prompt runs non-interactively.
#                              Note: -p is deprecated and means --profile, not --prompt.
#   --model                    Override the model for this session.
#   --yolo                     Auto-approve all tool calls (required for headless use).
#   --output-format stream-json
#                              Newline-delimited JSON events; compatible with the
#                              factory's log parsing.

set -euo pipefail

echo "[agent/gemini] Starting agent gemini in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/gemini] About to run (as ${SAIFCTL_UNPRIV_USER}): gemini --model \"${LLM_MODEL_ID}\" --yolo --output-format stream-json \"${_SAIFCTL_TASK_SNIP}\""

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
  -c '
    set -euo pipefail
    export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export GEMINI_API_KEY="${GEMINI_API_KEY:-${LLM_API_KEY:-}}"
    gemini \
      --model "$LLM_MODEL_ID" \
      --yolo \
      --output-format stream-json \
      "$(cat "$SAIFCTL_TASK_PATH")"
  ' < /dev/null || _agent_exit=$?

echo "[agent/gemini] Finished agent gemini in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
