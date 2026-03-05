#!/bin/bash
# Qwen Code agent script — runs Qwen with the task read from $FACTORY_TASK_PATH.
#
# Part of the qwen agent profile. Selected via --agent qwen.
# coder-start.sh writes the current task to $FACTORY_TASK_PATH before each invocation.
#
# CLI reference: https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
#
# Model and API key:
#   Qwen Code supports multiple protocols, each with its own env vars:
#     - OpenAI-compatible: OPENAI_API_KEY + OPENAI_BASE_URL  (OpenRouter, proxies, etc.)
#     - Alibaba DashScope: DASHSCOPE_API_KEY                 (native Qwen models)
#     - Anthropic:         ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
#     - Google GenAI:      GEMINI_API_KEY
#   The factory provides LLM_API_KEY (generic) and LLM_MODEL. We export LLM_API_KEY as
#   fallback for the two most common paths: DASHSCOPE_API_KEY (native) and OPENAI_API_KEY
#   (OpenAI-compatible). LLM_BASE_URL maps to OPENAI_BASE_URL for proxy/custom endpoint use.
#   Auth docs: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
#
# Key flags:
#   -p / --prompt              Run in headless mode with a prompt string; exits when done.
#   --model                    Override the model for this session.
#   --yolo / -y                Auto-approve all tool actions without prompting (required
#                              for headless use).
#   --output-format stream-json
#                              Emit newline-delimited JSON events; compatible with the
#                              factory's log parsing and lets the loop stream progress.
#
# Note: Qwen Code has no --ephemeral flag. Sessions are project-scoped under
# ~/.qwen/projects/<cwd>/ and auto-pruned. This is acceptable for the factory use case.
#
# No turn limit is set, so Qwen runs until it naturally finishes the task.

set -euo pipefail

export DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-$LLM_API_KEY}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
if [ -n "${LLM_BASE_URL:-}" ]; then
  export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$LLM_BASE_URL}"
fi

qwen \
  --prompt "$(cat "$FACTORY_TASK_PATH")" \
  --model "$LLM_MODEL" \
  --yolo \
  --output-format stream-json
