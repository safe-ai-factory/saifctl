#!/bin/sh
# go-node-python sandbox profile — installation script.
# Downloads Go module dependencies declared in go.mod.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing dependencies (go mod)..."
if [ -f go.mod ]; then
  go mod download
else
  echo "[factory-startup] No go.mod found — skipping."
fi
echo "[factory-startup] Done."
