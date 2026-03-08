#!/bin/sh
# python-pip-node sandbox profile — stage script.
# Starts the app server if a Procfile 'web' entry or a common entrypoint exists,
# otherwise keeps the container alive via `wait` (CLI-only projects).
# Invoked by staging-start.sh after the installation script and the sidecar have run.
# Set via --profile (default) or --stage-script.
#
# Example (custom start command):
#   #!/bin/sh
#   exec python app.py
#
# Example (keep-alive for CLI-only projects):
#   #!/bin/sh
#   wait
set -eu

cd /workspace

if [ -f Procfile ] && grep -q '^web:' Procfile; then
  echo "[app] Starting web server (Procfile web)..."
  exec sh -c "$(grep '^web:' Procfile | sed 's/^web: //')"
elif [ -f app.py ]; then
  echo "[app] Starting web server (app.py)..."
  exec python app.py
elif [ -f main.py ]; then
  echo "[app] Starting web server (main.py)..."
  exec python main.py
else
  echo "[app] No entrypoint found — sidecar is the only process."
  wait
fi
