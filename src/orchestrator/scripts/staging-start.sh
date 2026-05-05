#!/bin/sh
# Staging container startup — internal wiring, always runs first.
#
# Environment variables set by the orchestrator:
#   SAIFCTL_STARTUP_SCRIPT  — path to the installation script (same script used by the
#                             coder container); installs workspace dependencies once.
#   SAIFCTL_SIDECAR_PORT    — port for the sidecar HTTP server
#   SAIFCTL_SIDECAR_PATH    — HTTP path handled by the sidecar
#   SAIFCTL_STAGE_SCRIPT    — path to the stage script. Set via --profile or --stage-script.
#
# Execution order:
#   1. Run SAIFCTL_STARTUP_SCRIPT — the installation script (e.g. pnpm install, pip install, cargo fetch).
#      This is the same script the coder container runs, ensuring the staging
#      environment matches the environment in which the code was written.
#   2. Start the sidecar HTTP server in the background so the test runner can
#      execute commands via HTTP.
#   3. Run SAIFCTL_STAGE_SCRIPT — the profile's stage script (e.g. pnpm run start for
#      web projects, or `wait` for CLI-only). Set via --profile (default: node-pnpm-python)
#      or --stage-script.
#   4. After the stage script exits (or if it never blocks), wait for the sidecar
#      so the container stays alive as long as the sidecar is running.
#      This ensures the staging container does not exit while the test runner is active.
set -eu

# Diagnostic instrumentation — Linux runners hit a `cd /workspace` failure that
# does not reproduce on macOS Docker Desktop (where bind-mount UIDs are
# translated). Print enough state on every start so the failure mode is
# obvious in CI logs without needing to commit-and-re-run. Errors are
# swallowed individually so this never masks the real failure that follows.
# Tracked: release-readiness/X-08-P3 follow-up (Linux UID/bind-mount compat for staging+test).
echo "[staging-start] diag: id=$(id 2>&1)" >&2
echo "[staging-start] diag: caps=$(grep -E '^Cap(Inh|Eff|Bnd|Prm)' /proc/self/status 2>/dev/null | tr '\n' ' ' || true)" >&2
if [ -e /workspace ]; then
  echo "[staging-start] diag: /workspace stat: $(stat -c 'mode=%a uid=%u gid=%g type=%F' /workspace 2>&1 || true)" >&2
  echo "[staging-start] diag: /workspace ls (first 5):" >&2
  ls -la /workspace 2>&1 | head -6 >&2 || true
else
  echo "[staging-start] diag: /workspace MISSING — bind mount did not materialise" >&2
fi

cd /workspace

if [ -z "${SAIFCTL_STARTUP_SCRIPT:-}" ]; then
  echo "[staging-start] ERROR: SAIFCTL_STARTUP_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$SAIFCTL_STARTUP_SCRIPT" ]; then
  echo "[staging-start] ERROR: startup script not found: $SAIFCTL_STARTUP_SCRIPT" >&2
  exit 1
fi

echo "[staging-start] Running startup script: $SAIFCTL_STARTUP_SCRIPT"
sh "$SAIFCTL_STARTUP_SCRIPT"
echo "[staging-start] Startup script completed."

echo "[staging-start] Starting sidecar server in background..."
PORT="${SAIFCTL_SIDECAR_PORT}" \
  SIDECAR_PATH="${SAIFCTL_SIDECAR_PATH}" \
  WORKSPACE=/workspace \
  /saifctl/sidecar &
SIDECAR_PID=$!

if [ -z "${SAIFCTL_STAGE_SCRIPT:-}" ]; then
  echo "[staging-start] ERROR: SAIFCTL_STAGE_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$SAIFCTL_STAGE_SCRIPT" ]; then
  echo "[staging-start] ERROR: stage script not found: $SAIFCTL_STAGE_SCRIPT" >&2
  exit 1
fi

echo "[staging-start] Running stage script: $SAIFCTL_STAGE_SCRIPT"
sh "$SAIFCTL_STAGE_SCRIPT"

# Stage script returned (CLI-only projects use `wait` or exit immediately).
# Keep the container alive by waiting on the sidecar process, which is the
# only remaining long-lived process. This replaces the previous `exec` which
# handed control to the stage script and lost track of the sidecar PID.
echo "[staging-start] Stage script returned — waiting on sidecar (pid $SIDECAR_PID)..."
wait "$SIDECAR_PID"
