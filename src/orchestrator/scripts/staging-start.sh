#!/bin/sh
# Staging container startup — internal wiring, always runs first.
#
# Environment variables set by the orchestrator:
#   FACTORY_STARTUP_SCRIPT  — path to the installation script (same script used by the
#                             coder container); installs workspace dependencies once.
#   FACTORY_SIDECAR_PORT    — port for the sidecar HTTP server
#   FACTORY_SIDECAR_PATH    — HTTP path handled by the sidecar
#   FACTORY_STAGE_SCRIPT    — path to the stage script. Set via --profile or --stage-script.
#
# Execution order:
#   1. Run FACTORY_STARTUP_SCRIPT — the installation script (e.g. pnpm install, pip install, cargo fetch).
#      This is the same script the coder container runs, ensuring the staging
#      environment matches the environment in which the code was written.
#   2. Start the sidecar HTTP server in the background so the test runner can
#      execute commands via HTTP.
#   3. Run FACTORY_STAGE_SCRIPT — the profile's stage script (e.g. pnpm run start for
#      web projects, or `wait` for CLI-only). Set via --profile (default: node-pnpm-python)
#      or --stage-script.
set -eu

cd /workspace

if [ -z "${FACTORY_STARTUP_SCRIPT:-}" ]; then
  echo "[app] ERROR: FACTORY_STARTUP_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$FACTORY_STARTUP_SCRIPT" ]; then
  echo "[app] ERROR: startup script not found: $FACTORY_STARTUP_SCRIPT" >&2
  exit 1
fi

echo "[app] Running startup script: $FACTORY_STARTUP_SCRIPT"
sh "$FACTORY_STARTUP_SCRIPT"
echo "[app] Startup script completed."

echo "[app] Starting sidecar server in background..."
PORT="${FACTORY_SIDECAR_PORT}" \
  SIDECAR_PATH="${FACTORY_SIDECAR_PATH}" \
  WORKSPACE=/workspace \
  node /workspace/sidecar-server.cjs &

if [ -z "${FACTORY_STAGE_SCRIPT:-}" ]; then
  echo "[app] ERROR: FACTORY_STAGE_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$FACTORY_STAGE_SCRIPT" ]; then
  echo "[app] ERROR: stage script not found: $FACTORY_STAGE_SCRIPT" >&2
  exit 1
fi

echo "[app] Running stage script: $FACTORY_STAGE_SCRIPT"
exec sh "$FACTORY_STAGE_SCRIPT"
