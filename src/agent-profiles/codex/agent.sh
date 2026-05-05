#!/bin/bash
# Codex agent script — runs Codex with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the codex agent profile. Selected via --agent codex.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference: https://developers.openai.com/codex/cli/reference
#
# Drop-privileges: claude/agent.sh and the helper at
# /saifctl/saifctl-agent-helpers.sh document the shared scaffold (X08-P7/P8).
# Codex runs as $SAIFCTL_UNPRIV_USER for the same least-privilege reason.
#
# Model and API key:
#   Codex expects OPENAI_API_KEY. The factory provides LLM_API_KEY (generic) and
#   LLM_MODEL_ID (bare model id; LLM_MODEL is the prefixed `provider/model` form
#   for LiteLLM-style agents and would be rejected by Codex's CLI as an unknown
#   model). We fall back to LLM_API_KEY when OPENAI_API_KEY is not set, and
#   pass LLM_MODEL_ID via --model to override Codex's default.
#   LLM_BASE_URL is forwarded as OPENAI_BASE_URL for custom endpoint support.
#   If OPENAI_BASE_URL is already set in the environment, it takes precedence.
#
# Key flags:
#   exec                       Non-interactive subcommand: run Codex headlessly and exit.
#   --model                    Override the model for this run.
#   -  (PROMPT arg)            Read the prompt from stdin instead of a string argument.
#   --dangerously-bypass-approvals-and-sandbox / --yolo
#                              Skip all approval prompts and sandbox restrictions.
#                              Safe here because the factory container is already
#                              sandboxed by Leash.
#   --json                     Emit newline-delimited JSON events; compatible with the
#                              factory's log parsing and lets the loop stream progress.
#   --ephemeral                Do not persist session files to disk; each factory round
#                              is independent.

set -euo pipefail

echo "[agent/codex] Starting agent codex in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent/codex] About to run (as ${SAIFCTL_UNPRIV_USER}): codex exec --model \"${LLM_MODEL_ID}\" --dangerously-bypass-approvals-and-sandbox --json --ephemeral - < \"${SAIFCTL_TASK_PATH}\""

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
  -c '
    set -euo pipefail
    export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    if [ -n "${LLM_BASE_URL:-}" ]; then
      export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$LLM_BASE_URL}"
    fi
    codex exec \
      --model "$LLM_MODEL_ID" \
      --dangerously-bypass-approvals-and-sandbox \
      --json \
      --ephemeral \
      - < "$SAIFCTL_TASK_PATH"
  ' || _agent_exit=$?

echo "[agent/codex] Finished agent codex in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
