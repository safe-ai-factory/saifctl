#!/bin/bash
# coder-start.sh — inner agentic loop, baked into the coder image at /factory/coder-start.sh.
#
# Runs the agent script, then calls /factory/gate.sh (injected read-only per-run).
# If the gate passes (exit 0), the container exits successfully.
# If the gate fails, the failure output is appended to the task prompt and
# the agent is re-invoked, up to FACTORY_INNER_ROUNDS times.
#
# Environment variables:
#   FACTORY_INITIAL_TASK        — the full task prompt (required)
#   FACTORY_INNER_ROUNDS        — max inner rounds before giving up (default: 5)
#   FACTORY_GATE_SCRIPT         — path to the gate script (default: /factory/gate.sh)
#   FACTORY_STARTUP_SCRIPT      — path to the installation script (required); run once before
#                                 the agent loop. Set via --profile (default: node-pnpm-python) or
#                                 --startup-script.
#   FACTORY_AGENT_START_SCRIPT  — (optional) path to an agent setup script; run once after
#                                 the startup script and before the agent loop. Use to
#                                 install the coding agent (e.g. pipx install aider-chat).
#                                 When unset or empty, this step is skipped.
#   FACTORY_AGENT_SCRIPT        — path to the agent script (default: /factory/agent.sh)
#                                 The script is called once per inner round. It must read
#                                 the task from $FACTORY_TASK_PATH and run the coding agent.
#   FACTORY_TASK_PATH           — path where the current task prompt is written before each
#                                 agent invocation (default: /workspace/.factory_task.md).
#                                 Agent scripts should read from this file rather than from
#                                 command-line arguments to avoid escaping and length issues.

set -euo pipefail

GATE_SCRIPT="${FACTORY_GATE_SCRIPT:-/factory/gate.sh}"
AGENT_SCRIPT="${FACTORY_AGENT_SCRIPT:-/factory/agent.sh}"
TASK_PATH="${FACTORY_TASK_PATH:-/workspace/.factory_task.md}"
MAX_ROUNDS="${FACTORY_INNER_ROUNDS:-5}"

if [ -z "${FACTORY_INITIAL_TASK:-}" ]; then
  echo "[coder-start] ERROR: FACTORY_INITIAL_TASK is not set." >&2
  exit 1
fi

if [ -z "${FACTORY_STARTUP_SCRIPT:-}" ]; then
  echo "[coder-start] ERROR: FACTORY_STARTUP_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$FACTORY_STARTUP_SCRIPT" ]; then
  echo "[coder-start] ERROR: startup script not found: $FACTORY_STARTUP_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$AGENT_SCRIPT" ]; then
  echo "[coder-start] ERROR: agent script not found: $AGENT_SCRIPT" >&2
  exit 1
fi

echo "[coder-start] Running startup script: $FACTORY_STARTUP_SCRIPT"
bash "$FACTORY_STARTUP_SCRIPT"
echo "[coder-start] Startup script completed."

if [ -n "${FACTORY_AGENT_START_SCRIPT:-}" ]; then
  if [ ! -f "$FACTORY_AGENT_START_SCRIPT" ]; then
    echo "[coder-start] ERROR: agent start script not found: $FACTORY_AGENT_START_SCRIPT" >&2
    exit 1
  fi
  echo "[coder-start] Running agent setup script: $FACTORY_AGENT_START_SCRIPT"
  bash "$FACTORY_AGENT_START_SCRIPT"
  echo "[coder-start] Agent setup script completed."
fi

INITIAL_TASK="$FACTORY_INITIAL_TASK"
round=0
current_task="$INITIAL_TASK"

while [ "$round" -lt "$MAX_ROUNDS" ]; do
  round=$((round + 1))
  echo "[coder-start] ===== Round $round/$MAX_ROUNDS ====="

  # Write the current task to FACTORY_TASK_PATH so the agent script can read it.
  # Agent scripts must consume the task from this file (not from env var or CLI args).
  export FACTORY_TASK_PATH="$TASK_PATH"
  mkdir -p "$(dirname "$TASK_PATH")"
  printf '%s' "$current_task" > "$TASK_PATH"

  # This is where we call the actual agent, e.g. OpenHands, Aider, Claude, Codex, etc.
  # Instead of calling openhands directly, we call the agent script - a bash script
  # that can contain anything. This way we can use any agent, not just OpenHands.
  echo "[coder-start] Running agent: $AGENT_SCRIPT"
  bash "$AGENT_SCRIPT"
  echo "[coder-start] Agent completed."

  if [ ! -f "$GATE_SCRIPT" ]; then
    echo "[coder-start] No gate script found at $GATE_SCRIPT — exiting with success."
    exit 0
  fi

  echo "[coder-start] Running gate: $GATE_SCRIPT"
  # Capture stdout+stderr; preserve exit code without triggering set -e.
  gate_output=$("$GATE_SCRIPT" 2>&1) && gate_exit=0 || gate_exit=$?

  if [ "$gate_exit" -eq 0 ]; then
    echo "[coder-start] Gate PASSED."
    exit 0
  fi

  echo "[coder-start] Gate FAILED (round $round/$MAX_ROUNDS):"
  echo "$gate_output"

  if [ "$round" -ge "$MAX_ROUNDS" ]; then
    break
  fi

  # Rebuild prompt: original task + failure feedback.
  current_task="$(printf '%s\n\n## Validation Failed — Fix Before Finishing\n\n```\n%s\n```\n\nFix the above issues.' \
    "$INITIAL_TASK" "$gate_output")"
done

echo "[coder-start] Exhausted $MAX_ROUNDS inner round(s) without gate passing."
exit 1
