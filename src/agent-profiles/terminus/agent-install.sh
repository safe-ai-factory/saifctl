#!/bin/bash
# Terminus agent setup script — installs terminus-ai via uv tool install as
# the saifctl unprivileged user. See specification.md §4.1 X08-P7/P8 + the
# shared helpers at /saifctl/saifctl-agent-helpers.sh.
#
# Pinned version (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/terminus-ai/ — terminus-ai==2.0.4
#   Requires-Python: >=3.12  →  install with CPython 3.13 (pinned).
#
# Hard requirement: tmux (Terminus uses a tmux session as its sole environment-
# interaction tool). We install tmux as root before dropping privileges.

TERMINUS_PACKAGE_VERSION='2.0.4'
TERMINUS_PYTHON_PIN='3.13'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/terminus] Finished Terminus setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/terminus] Installing Terminus (agent-install.sh)..."

# tmux must be installed BEFORE dropping privileges — apt/dnf/pacman need root.
# Skip if already present (custom images may pre-bake it).
if ! command -v tmux &>/dev/null; then
  echo "[agent-install/terminus] tmux not found — attempting to install (as root)..." >&2
  if command -v apt-get &>/dev/null; then
    apt-get update >/dev/null 2>&1 || true
    apt-get install -y tmux
  elif command -v dnf &>/dev/null; then
    dnf install -y tmux
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm tmux
  else
    echo "[agent-install/terminus] ERROR: Cannot install tmux automatically (no apt/dnf/pacman). Bake tmux into the coder image." >&2
    exit 1
  fi
fi
echo "[agent-install/terminus] tmux is available: $(tmux -V)"

# Now drop privileges and install Terminus into saifctl's uv tool prefix.
# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'export PATH="$HOME/.local/bin:$PATH"; command -v terminus >/dev/null 2>&1 && terminus --version 2>/dev/null' || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/terminus] terminus already installed for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

if ! command -v uv &>/dev/null; then
  echo "[agent-install/terminus] ERROR: uv is not available in this image." >&2
  echo "[agent-install/terminus] Use a uv-capable sandbox profile (python-uv*) or bake terminus-ai into a custom --coder-image." >&2
  exit 1
fi

echo "[agent-install/terminus] Installing terminus-ai==${TERMINUS_PACKAGE_VERSION} via uv (Python ${TERMINUS_PYTHON_PIN}) as ${SAIFCTL_UNPRIV_USER}..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "uv tool install 'terminus-ai==${TERMINUS_PACKAGE_VERSION}' --python '${TERMINUS_PYTHON_PIN}'"

_after="$(_probe)"
echo "[agent-install/terminus] terminus installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
