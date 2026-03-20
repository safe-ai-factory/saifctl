#!/bin/sh
# Staging container startup — internal wiring, always runs first.
#
# Environment variables set by the orchestrator:
#   SAIFAC_STARTUP_SCRIPT  — path to the installation script (same script used by the
#                             coder container); installs workspace dependencies once.
#   SAIFAC_SIDECAR_PORT    — port for the sidecar HTTP server
#   SAIFAC_SIDECAR_PATH    — HTTP path handled by the sidecar
#   SAIFAC_STAGE_SCRIPT    — path to the stage script. Set via --profile or --stage-script.
#
# Execution order:
#   1. Run SAIFAC_STARTUP_SCRIPT — the installation script (e.g. pnpm install, pip install, cargo fetch).
#      This is the same script the coder container runs, ensuring the staging
#      environment matches the environment in which the code was written.
#   2. Start the sidecar HTTP server in the background so the test runner can
#      execute commands via HTTP.
#   3. Run SAIFAC_STAGE_SCRIPT — the profile's stage script (e.g. pnpm run start for
#      web projects, or `wait` for CLI-only). Set via --profile (default: node-pnpm-python)
#      or --stage-script.
set -eu

cd /workspace

if [ -z "${SAIFAC_STARTUP_SCRIPT:-}" ]; then
  echo "[app] ERROR: SAIFAC_STARTUP_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$SAIFAC_STARTUP_SCRIPT" ]; then
  echo "[app] ERROR: startup script not found: $SAIFAC_STARTUP_SCRIPT" >&2
  exit 1
fi

echo "[app] Running startup script: $SAIFAC_STARTUP_SCRIPT"
sh "$SAIFAC_STARTUP_SCRIPT"
echo "[app] Startup script completed."

echo "[app] Starting sidecar server in background..."
PORT="${SAIFAC_SIDECAR_PORT}" \
  SIDECAR_PATH="${SAIFAC_SIDECAR_PATH}" \
  WORKSPACE=/workspace \
  /saifac/sidecar &

if [ -z "${SAIFAC_STAGE_SCRIPT:-}" ]; then
  echo "[app] ERROR: SAIFAC_STAGE_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$SAIFAC_STAGE_SCRIPT" ]; then
  echo "[app] ERROR: stage script not found: $SAIFAC_STAGE_SCRIPT" >&2
  exit 1
fi

echo "[app] Running stage script: $SAIFAC_STAGE_SCRIPT"
exec sh "$SAIFAC_STAGE_SCRIPT"
