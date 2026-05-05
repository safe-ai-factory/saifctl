#!/bin/bash
# Deep Agents CLI agent script — runs `deepagents` with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the deepagents agent profile. Selected via --agent deepagents.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (release-readiness/X-08-P7/P8).
#
# CLI reference: https://docs.langchain.com/oss/python/deepagents/cli
#
# Invocation:
#   deepagents -n "TASK"          Non-interactive mode.
#   --auto-approve                Yolo / autonomous mode (skip approvals).
#   --shell-allow-list recommended  Enable common safe shell commands.
#   -M / --model                  Model in provider:model format.
#   -a / --agent                  Named agent (we use 'factory' to isolate).
#
# API keys: deepagents reads native provider env vars. We export LLM_API_KEY as
# fallback for the most common ones inside the runuser shell.
#
# Model: deepagents wants `provider:model` (colon, NOT slash). The factory
# provides LLM_MODEL_ID (bare model id) and LLM_PROVIDER separately; we
# combine them into the colon form below. Reading LLM_MODEL directly would
# double the provider — `LLM_MODEL` is the slash form (`anthropic/claude-…`)
# for LiteLLM-style agents, and the colon-detection check `!= *:*` would pass
# (no colon), causing the prefix to get prepended a second time
# (`anthropic:anthropic/claude-…`). Using LLM_MODEL_ID makes the existing
# defensive logic correct in one step.
#
# Base URL: deepagents has no CLI flag; we inject a per-agent
# ~/.deepagents/factory/config.toml with the provider-scoped base_url override
# (provider derived from LLM_PROVIDER directly — no fallback to LLM_MODEL
# parsing because LLM_PROVIDER is always set when the orchestrator resolves an
# LLM config). Done inside the runuser shell so the file is owned by saifctl.

set -euo pipefail

echo "[agent/deepagents] Starting agent deepagents in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/deepagents] About to run (as ${SAIFCTL_UNPRIV_USER}): deepagents --agent factory -n \"${_SAIFCTL_TASK_SNIP}\" --auto-approve --shell-allow-list recommended ${LLM_MODEL_ID:+--model …} (API keys / base-url from env, masked as ****)"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
  -c '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${LLM_API_KEY:-}}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"

    # Resolve model into deepagents' provider:model format. We start from
    # LLM_MODEL_ID (bare) — NOT LLM_MODEL (slash form) — and prepend
    # ${LLM_PROVIDER}: when not already in colon form. Using LLM_MODEL here
    # would silently produce `anthropic:anthropic/claude-…` (the colon-check
    # passes on slash-form input). The defensive `!= *:*` check is kept so a
    # user who explicitly passes `--model anthropic:opus` via --agent-env
    # bypasses the auto-prefix.
    _model_flag=()
    if [ -n "${LLM_MODEL_ID:-}" ]; then
      _resolved_model="$LLM_MODEL_ID"
      if [[ "$_resolved_model" != *:* ]] && [ -n "${LLM_PROVIDER:-}" ]; then
        _resolved_model="${LLM_PROVIDER}:${_resolved_model}"
      fi
      _model_flag=(--model "$_resolved_model")
    fi

    # Base URL → per-agent config.toml override (deepagents has no CLI flag
    # for it). LLM_PROVIDER is always set when the orchestrator resolves an
    # LLM config (see LlmConfig in src/llm-config.ts); we read it directly
    # rather than parsing LLM_MODEL. The previous fallback that tried to
    # extract a provider from `LLM_MODEL`'s colon prefix was dead code today
    # — LLM_MODEL is slash-separated, not colon-separated.
    if [ -n "${LLM_BASE_URL:-}" ]; then
      _provider="${LLM_PROVIDER:-openai}"
      _factory_dir="$HOME/.deepagents/factory"
      mkdir -p "$_factory_dir"
      cat > "$_factory_dir/config.toml" <<EOF
[models.providers.${_provider}]
base_url = "${LLM_BASE_URL}"
EOF
    fi

    deepagents \
      --agent factory \
      -n "$(cat "$SAIFCTL_TASK_PATH")" \
      --auto-approve \
      --shell-allow-list recommended \
      "${_model_flag[@]}"
  ' < /dev/null || _agent_exit=$?

echo "[agent/deepagents] Finished agent deepagents in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
