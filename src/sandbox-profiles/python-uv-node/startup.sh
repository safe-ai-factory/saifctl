#!/bin/sh
# python-uv-node sandbox profile — installation script.
# Installs Python dependencies via uv.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing Python dependencies (uv)..."
if [ -f pyproject.toml ]; then
  uv sync
elif [ -f requirements.txt ]; then
  uv pip install -r requirements.txt
else
  echo "[factory-startup] No pyproject.toml or requirements.txt found — skipping."
fi
echo "[factory-startup] Done."
