#!/bin/sh
# rust sandbox profile — installation script.
# Pre-fetches Cargo dependencies declared in Cargo.toml so the first build is fast.
# Runs in both the coder container (before the agent loop) and the staging container
# (before the app starts). Set via --profile (default) or --startup-script.
set -eu
cd /workspace
echo "[factory-startup] Installing dependencies (cargo fetch)..."
if [ -f Cargo.toml ]; then
  cargo fetch
else
  echo "[factory-startup] No Cargo.toml found — skipping."
fi
echo "[factory-startup] Done."
