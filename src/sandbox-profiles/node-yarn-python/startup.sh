#!/bin/sh
# node-yarn-python sandbox profile — installation script.
# Installs Node.js dependencies via Yarn.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing Node.js dependencies (yarn)..."
yarn install --frozen-lockfile 2>/dev/null || yarn install
echo "[factory-startup] Done."
