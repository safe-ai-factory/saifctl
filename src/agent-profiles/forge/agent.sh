#!/bin/bash
# Forge Code agent script — runs forge with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the forge agent profile. Selected via --agent forge.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (release-readiness/X-08-P7/P8).
#
# Forge is a compiled Rust binary that runs fully headlessly with no
# interactive prompts.
#
# CLI reference: https://forgecode.dev/docs/cli-reference/
# Env config:    https://forgecode.dev/docs/environment-configuration/
#
# Invocation:
#   forge -p "TASK"     Non-interactive mode.
#   --agent forge       Full read-write execution agent (default; explicit for clarity).
#   --verbose           Verbose output for factory log inspection.
#
# API keys (priority order — Forge reads these directly):
#   FORGE_KEY → OPENROUTER_API_KEY → OPENAI_API_KEY → ANTHROPIC_API_KEY
#
# Base URL: LLM_BASE_URL → OPENAI_URL (OpenAI-compatible). For Anthropic-
# compatible endpoints set ANTHROPIC_URL directly.
#
# Model: Forge has no --model CLI flag — we use `forge config set model …`
# inside the runuser shell to pin the model for this invocation.
#
#   GOTCHA — provider-dependent format. Forge's internal model registry
#   accepts different shapes depending on which provider is configured:
#     - OpenAI:           bare id      (e.g. `o1`, `gpt-5`)
#     - HuggingFace-style: org/model    (e.g. `meta-llama/Llama-3.3-70B-Instruct`)
#     - Anthropic:        bare id      (e.g. `claude-sonnet-4.5`)
#   Saifctl's factory format is always `provider/model` (or `provider/org/model`
#   for OpenRouter), and there is no universally-right translation. We pass
#   `LLM_MODEL` through verbatim — that works for OpenRouter, HuggingFace, and
#   any provider whose forge identifier already includes a slash. For OpenAI
#   and Anthropic, the user must either:
#     (a) pre-configure the model via .forge.toml (`[session] model_id = "o1"`),
#         which takes precedence over this `forge config set` call when the
#         `forge config set` invocation fails (the `|| true` guard below), OR
#     (b) supply LLM_MODEL_ID directly via `--agent-env LLM_MODEL=<bare-id>` to
#         override the orchestrator's auto-prefixed value.
#   We do NOT switch to `$LLM_MODEL_ID` here because that would silently break
#   the HuggingFace and OpenRouter paths that need the prefix preserved. See
#   the analysis in release-readiness/X-08 (open sub-phase) for the full provider matrix.

set -euo pipefail

echo "[agent/forge] Starting agent forge in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/forge] About to run (as ${SAIFCTL_UNPRIV_USER}): forge --agent forge --verbose -p \"${_SAIFCTL_TASK_SNIP}\" (API keys/base-url from env, masked as ****)"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist),FORGE_KEY,OPENAI_URL,ANTHROPIC_URL" \
  -c '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export FORGE_KEY="${FORGE_KEY:-${LLM_API_KEY:-}}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${LLM_API_KEY:-}}"
    if [ -n "${LLM_BASE_URL:-}" ]; then
      export OPENAI_URL="${OPENAI_URL:-$LLM_BASE_URL}"
    fi
    if [ -n "${LLM_MODEL:-}" ]; then
      forge config set model "$LLM_MODEL" 2>/dev/null || true
    fi
    forge \
      --agent forge \
      --verbose \
      -p "$(cat "$SAIFCTL_TASK_PATH")"
  ' < /dev/null || _agent_exit=$?

echo "[agent/forge] Finished agent forge in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
