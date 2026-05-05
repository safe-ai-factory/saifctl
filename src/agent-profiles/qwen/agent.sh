#!/bin/bash
# Qwen Code agent script — runs Qwen with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the qwen agent profile. Selected via --agent qwen.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference: https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (X08-P7/P8).
#
# Model and API key:
#   Qwen Code supports multiple protocols, each with its own env vars:
#     - OpenAI-compatible: OPENAI_API_KEY + OPENAI_BASE_URL  (OpenRouter, proxies, etc.)
#     - Alibaba DashScope: DASHSCOPE_API_KEY                 (native Qwen models)
#     - Anthropic:         ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
#     - Google GenAI:      GEMINI_API_KEY
#   The factory provides LLM_API_KEY + LLM_MODEL_ID. We export LLM_API_KEY as
#   fallback for the two most common paths: DASHSCOPE_API_KEY and OPENAI_API_KEY.
#   LLM_BASE_URL maps to OPENAI_BASE_URL for proxy/custom endpoint use.
#   Auth docs: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
#
# Key flags:
#   -p / --prompt              Headless mode with a prompt; exits when done.
#   --model                    Override the model for this session.
#   --yolo / -y                Auto-approve all tool actions (required for headless use).
#   --output-format stream-json
#                              Newline-delimited JSON events; compatible with the
#                              factory's log parsing.

set -euo pipefail

echo "[agent/qwen] Starting agent qwen in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/qwen] About to run (as ${SAIFCTL_UNPRIV_USER}): qwen --prompt \"${_SAIFCTL_TASK_SNIP}\" --model \"${LLM_MODEL_ID}\" --yolo --output-format stream-json"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
  -c '
    set -euo pipefail
    export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-${LLM_API_KEY:-}}"
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    if [ -n "${LLM_BASE_URL:-}" ]; then
      export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$LLM_BASE_URL}"
    fi
    qwen \
      --prompt "$(cat "$SAIFCTL_TASK_PATH")" \
      --model "$LLM_MODEL_ID" \
      --yolo \
      --output-format stream-json
  ' < /dev/null || _agent_exit=$?

echo "[agent/qwen] Finished agent qwen in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
