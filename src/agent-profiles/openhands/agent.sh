#!/bin/bash
# OpenHands agent script — invokes OpenHands with the task read from $FACTORY_TASK_PATH.
#
# Part of the openhands agent profile. Selected via --agent openhands (default).
# factory-loop.sh writes the current task to $FACTORY_TASK_PATH before each invocation.

set -euo pipefail

openhands --headless --always-approve --override-with-envs --json -t "$(cat "$FACTORY_TASK_PATH")"
