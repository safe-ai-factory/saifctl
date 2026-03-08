#!/bin/sh
# node-npm-python sandbox profile — installation script.
# Installs Node.js dependencies via npm.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing Node.js dependencies (npm)..."
npm ci 2>/dev/null || npm install
echo "[factory-startup] Done."
