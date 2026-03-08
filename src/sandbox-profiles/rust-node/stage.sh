#!/bin/sh
# rust-node sandbox profile — stage script.
# Builds and runs the Rust application in release mode, or keeps the container
# alive for CLI-only projects. Invoked by staging-start.sh after the installation
# script and the sidecar have run. Set via --profile (default) or --stage-script.
#
# Example (custom start command):
#   #!/bin/sh
#   exec cargo run --release --bin my-server
#
# Example (keep-alive for CLI-only projects):
#   #!/bin/sh
#   wait
set -eu

cd /workspace

if [ -f Procfile ] && grep -q '^web:' Procfile; then
  echo "[app] Starting web server (Procfile web)..."
  exec sh -c "$(grep '^web:' Procfile | sed 's/^web: //')"
elif [ -f Cargo.toml ]; then
  echo "[app] Building and starting app (cargo run --release)..."
  exec cargo run --release
else
  echo "[app] No entrypoint found — sidecar is the only process."
  wait
fi
