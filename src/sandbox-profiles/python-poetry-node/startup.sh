#!/bin/sh
# python-poetry-node sandbox profile — installation script.
# Installs Python dependencies via Poetry.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing Python dependencies (poetry)..."
if [ -f pyproject.toml ]; then
  poetry install
else
  echo "[factory-startup] No pyproject.toml found — skipping."
fi
echo "[factory-startup] Done."
