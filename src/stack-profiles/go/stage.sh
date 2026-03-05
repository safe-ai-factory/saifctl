#!/bin/sh
# go stack profile — stage script.
# Builds and runs the Go application, or keeps the container alive for CLI-only
# projects. Invoked by staging-start.sh after the installation script and the
# sidecar have run. Set via --profile (default) or --stage-script.
#
# Example (custom start command):
#   #!/bin/sh
#   exec go run ./cmd/server
#
# Example (keep-alive for CLI-only projects):
#   #!/bin/sh
#   wait
set -eu

cd /workspace

if [ -f Procfile ] && grep -q '^web:' Procfile; then
  echo "[app] Starting web server (Procfile web)..."
  exec sh -c "$(grep '^web:' Procfile | sed 's/^web: //')"
elif [ -f main.go ]; then
  echo "[app] Building and starting app (main.go)..."
  go build -o /tmp/app . && exec /tmp/app
elif [ -d cmd ]; then
  echo "[app] Building and starting app (cmd/)..."
  go build -o /tmp/app ./cmd/... && exec /tmp/app
else
  echo "[app] No entrypoint found — sidecar is the only process."
  wait
fi
