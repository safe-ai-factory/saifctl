#!/bin/bash
# sandbox-start.sh — interactive sandbox entry point; copied into the sandbox and bind-mounted at /saifctl/sandbox-start.sh.
#
# Runs startup and agent-install scripts (same as coder-start.sh), then sleeps indefinitely.
# The user connects via `docker exec -it <container> bash` to interact with the container.
#
# This is the container entry point for `saifctl sandbox --interactive`. Unlike coder-start.sh,
# there is no task, no gate, no retry loop, and no reviewer. The container stays alive until
# the saifctl process receives SIGINT/SIGTERM and calls session.stop().
#
# Environment variables:
#   SAIFCTL_STARTUP_SCRIPT       — path to the installation script (required); run once on startup.
#   SAIFCTL_AGENT_INSTALL_SCRIPT — (optional) path to an agent install script; run once after
#                                  the startup script. Use to install the coding agent
#                                  (e.g. `claude mcp add ...` or `pipx install aider-chat`).
#                                  When unset or empty, this step is skipped.

set -euo pipefail

if [ -z "${SAIFCTL_STARTUP_SCRIPT:-}" ]; then
  echo "[sandbox-start] ERROR: SAIFCTL_STARTUP_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$SAIFCTL_STARTUP_SCRIPT" ]; then
  echo "[sandbox-start] ERROR: startup script not found: $SAIFCTL_STARTUP_SCRIPT" >&2
  exit 1
fi

echo "[sandbox-start] Running startup script: $SAIFCTL_STARTUP_SCRIPT"
bash "$SAIFCTL_STARTUP_SCRIPT"
echo "[sandbox-start] Startup script completed."

if [ -n "${SAIFCTL_AGENT_INSTALL_SCRIPT:-}" ]; then
  if [ ! -f "$SAIFCTL_AGENT_INSTALL_SCRIPT" ]; then
    echo "[sandbox-start] ERROR: agent install script not found: $SAIFCTL_AGENT_INSTALL_SCRIPT" >&2
    exit 1
  fi
  echo "[sandbox-start] Running agent install script: $SAIFCTL_AGENT_INSTALL_SCRIPT"
  bash "$SAIFCTL_AGENT_INSTALL_SCRIPT"
  echo "[sandbox-start] Agent install script completed."
fi

echo "[sandbox-start] Ready. Connect with: docker exec -it <container> bash"
echo "[sandbox-start] Sleeping until stopped..."
sleep infinity
