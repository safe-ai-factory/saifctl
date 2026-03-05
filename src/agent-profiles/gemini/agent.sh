#!/bin/bash
# Gemini CLI agent script — runs Gemini with the task read from $FACTORY_TASK_PATH.
#
# Part of the gemini agent profile. Selected via --agent gemini.
# coder-start.sh writes the current task to $FACTORY_TASK_PATH before each invocation.
#
# CLI reference: https://geminicli.com/docs/reference/configuration/#command-line-arguments
#
# Model and API key:
#   Gemini expects GEMINI_API_KEY. The factory provides LLM_API_KEY (generic) and
#   LLM_MODEL. We fall back to LLM_API_KEY when GEMINI_API_KEY is not set, and
#   pass LLM_MODEL via --model to override Gemini's default.
#
#   Note: Gemini CLI does not currently support a base URL override via environment
#   variable. Multiple PRs proposing GEMINI_API_BASE_URL / GEMINI_BASEURL were closed
#   without merging. LLM_BASE_URL is not forwarded here.
#
# Key flags:
#   <prompt>                   Positional argument: the task text. Invoking gemini with
#                              a prompt runs it non-interactively and exits.
#                              Note: -p is deprecated and means --profile, not --prompt.
#   --model                    Override the model for this session.
#   --yolo                     Auto-approve all tool calls without prompting (required
#                              for headless use). Equivalent to --approval-mode=yolo.
#   --output-format stream-json
#                              Emit newline-delimited JSON events; compatible with the
#                              factory's log parsing and lets the loop stream progress.
#
# Note: Gemini CLI has no --ephemeral flag. Sessions age out automatically based on
# the general.sessionRetention settings (default: 30 days). This is acceptable for
# the factory use case.
#
# No turn limit is set (model.maxSessionTurns defaults to -1 = unlimited), so Gemini
# runs until it naturally finishes the task.

set -euo pipefail

export GEMINI_API_KEY="${GEMINI_API_KEY:-$LLM_API_KEY}"

gemini \
  --model "$LLM_MODEL" \
  --yolo \
  --output-format stream-json \
  "$(cat "$FACTORY_TASK_PATH")"
