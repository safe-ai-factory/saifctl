#!/bin/sh
# python-pip-node sandbox profile — installation script.
# Installs Python dependencies via pip (or uv if available).
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing Python dependencies (pip)..."
if command -v uv > /dev/null 2>&1 && [ -f pyproject.toml ]; then
  uv sync
elif [ -f requirements.txt ]; then
  pip install -r requirements.txt
else
  echo "[factory-startup] No requirements.txt or pyproject.toml found — skipping."
fi
echo "[factory-startup] Done."
