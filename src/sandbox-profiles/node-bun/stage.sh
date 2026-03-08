#!/bin/sh
# node-bun sandbox profile — stage script.
# Starts the app server if a 'start' script exists in package.json,
# otherwise keeps the container alive via `wait` (CLI-only projects).
# Invoked by staging-start.sh after the installation script and the sidecar have run.
# Set via --profile (default) or --stage-script.
#
# Example (custom start command):
#   #!/bin/sh
#   exec bun run dist/server.js
#
# Example (keep-alive for CLI-only projects):
#   #!/bin/sh
#   wait
set -eu

cd /workspace

if bun -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.start ? 0 : 1)" 2>/dev/null; then
  echo "[app] Starting web server..."
  exec bun run start
else
  echo "[app] No 'start' script — sidecar is the only process."
  wait
fi
