#!/bin/sh
# python-conda-node stack profile — installation script.
# Installs dependencies via conda (environment.yml) or pip (requirements.txt).
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing dependencies (conda)..."
if [ -f environment.yml ]; then
  conda env update -n base -f environment.yml --prune
elif [ -f requirements.txt ]; then
  pip install -r requirements.txt --quiet
else
  echo "[factory-startup] No environment.yml or requirements.txt found — skipping."
fi
echo "[factory-startup] Done."
