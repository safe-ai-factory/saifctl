#!/bin/sh
# node-bun-python stack profile — installation script.
# Installs dependencies via Bun.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing dependencies (bun)..."
bun install --frozen 2>/dev/null || bun install
echo "[factory-startup] Done."
