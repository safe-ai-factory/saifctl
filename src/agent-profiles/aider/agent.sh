#!/bin/bash
# Aider agent script — runs Aider with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the aider agent profile. Selected via --agent aider.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (release-readiness/X-08-P7/P8).
#
# CLI reference: https://aider.chat/docs/config/options.html
#
# Model and API key:
#   Aider uses litellm and reads native provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY,
#   OPENROUTER_API_KEY, GEMINI_API_KEY, etc.) automatically. The factory provides the
#   generic LLM_API_KEY and LLM_MODEL. We export LLM_API_KEY as fallback for all common
#   provider keys inside the runuser shell. Native keys take precedence.
#
#   LLM_BASE_URL is forwarded as OPENAI_API_BASE (used by litellm for custom endpoints).
#
# Key flags:
#   --model           Specify the model (env: AIDER_MODEL).
#   --message-file    Read the task from a file; process and exit (single-shot mode).
#   --yes             Auto-confirm all prompts (headless, non-interactive).
#   --no-auto-commits Disable aider's own git commits — the factory extracts a patch
#                     via `git diff HEAD` after the agent exits.
#   --no-check-update Suppress the update-available banner.
#   --no-suggest-shell-commands  Suppress shell-command suggestions (pointless headlessly).

set -euo pipefail

echo "[agent/aider] Starting agent aider in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent/aider] About to run (as ${SAIFCTL_UNPRIV_USER}): aider --model \"${LLM_MODEL}\" --message-file \"${SAIFCTL_TASK_PATH}\" --yes --no-auto-commits --no-check-update --no-suggest-shell-commands"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
  -c '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${LLM_API_KEY:-}}"
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"
    export GEMINI_API_KEY="${GEMINI_API_KEY:-${LLM_API_KEY:-}}"
    if [ -n "${LLM_BASE_URL:-}" ]; then
      export OPENAI_API_BASE="${OPENAI_API_BASE:-$LLM_BASE_URL}"
    fi
    aider \
      --model "$LLM_MODEL" \
      --message-file "$SAIFCTL_TASK_PATH" \
      --yes \
      --no-auto-commits \
      --no-check-update \
      --no-suggest-shell-commands
  ' < /dev/null || _agent_exit=$?

echo "[agent/aider] Finished agent aider in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
