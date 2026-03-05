#!/bin/bash
# OpenHands agent script — invokes OpenHands with the task read from $FACTORY_TASK_PATH.
#
# Part of the openhands agent profile. Selected via --agent openhands (default).
# coder-start.sh writes the current task to $FACTORY_TASK_PATH before each invocation.
#
# CLI reference: https://docs.openhands.dev/openhands/usage/cli/command-reference
#
# Model and API key:
#   OpenHands natively uses LLM_MODEL, LLM_API_KEY, and LLM_BASE_URL — the exact same
#   variable names the factory provides. No mapping needed.
#   --override-with-envs applies these env vars to override stored settings.
#
# Key flags:
#   --headless         Run without UI (required for automation).
#   --always-approve   Auto-approve all actions without confirmation.
#   --override-with-envs
#                      Apply LLM_MODEL, LLM_API_KEY, LLM_BASE_URL from environment.
#   --json             Emit JSONL output; parsed by the factory's openhands log formatter.
#   -t                 Task string to execute.

set -euo pipefail

openhands --headless --always-approve --override-with-envs --json -t "$(cat "$FACTORY_TASK_PATH")"
