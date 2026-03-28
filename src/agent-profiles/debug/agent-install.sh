#!/bin/bash
# Debug agent setup — intentionally empty (no CLI install).
#
# Runs once inside the coder container after the project startup script and
# before the agent loop (SAIFCTL_AGENT_INSTALL_SCRIPT in coder-start.sh).
# Use this profile to exercise the factory loop without waiting on pip/uv installs.

set -euo pipefail
trap 'ec=$?; echo "[agent-install/debug] Finished debug setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/debug] Skipping agent CLI install (debug profile noop)."
