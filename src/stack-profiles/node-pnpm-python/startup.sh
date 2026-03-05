#!/bin/sh
# node-pnpm-python stack profile — installation script.
# Installs Node.js dependencies via pnpm.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing Node.js dependencies (pnpm)..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
echo "[factory-startup] Done."
