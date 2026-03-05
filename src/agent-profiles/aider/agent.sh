#!/bin/bash
# Aider agent script — runs Aider with the task read from $FACTORY_TASK_PATH.
#
# Part of the aider agent profile. Selected via --agent aider.
# coder-start.sh writes the current task to $FACTORY_TASK_PATH before each invocation.
#
# Aider is installed by agent-start.sh (pipx) before the loop begins.
#
# CLI reference: https://aider.chat/docs/config/options.html
#
# Model and API key:
#   Aider uses litellm and reads native provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY,
#   OPENROUTER_API_KEY, GEMINI_API_KEY, etc.) automatically. The factory provides the
#   generic LLM_API_KEY and LLM_MODEL. We export LLM_API_KEY as fallback for all common
#   provider keys so the user only needs to provide LLM_API_KEY regardless of provider.
#   If a native key is already set in the environment, it takes precedence.
#
#   LLM_BASE_URL is forwarded as OPENAI_API_BASE (used by litellm for custom endpoints).
#   If OPENAI_API_BASE is already set in the environment, it takes precedence.
#
#   Model format is the user's responsibility — it must match whatever litellm/aider
#   expects for the chosen provider (e.g. "anthropic/claude-sonnet-4-5",
#   "openrouter/anthropic/claude-sonnet-4-5", "gpt-4o").
#
# Key flags:
#   --model           Specify the model (env: AIDER_MODEL).
#   --message-file    Read the task from a file; process it and exit (single-shot mode).
#                     The factory loop calls this script once per inner round.
#   --yes             Auto-confirm all prompts (headless, non-interactive).
#   --no-auto-commits Disable aider's own git commits. The factory loop extracts a patch
#                     via `git diff HEAD` after the agent exits; if aider commits first,
#                     the diff is empty and the factory sees "no changes made".
#   --no-check-update Suppress the update-available banner and any interactive prompt.
#   --no-suggest-shell-commands
#                     Suppress suggestions to run shell commands (pointless headlessly).

set -euo pipefail

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-$LLM_API_KEY}"
if [ -n "${LLM_BASE_URL:-}" ]; then
  export OPENAI_API_BASE="${OPENAI_API_BASE:-$LLM_BASE_URL}"
fi

aider \
  --model "$LLM_MODEL" \
  --message-file "$FACTORY_TASK_PATH" \
  --yes \
  --no-auto-commits \
  --no-check-update \
  --no-suggest-shell-commands
