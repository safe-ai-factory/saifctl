#!/bin/bash
# OpenCode agent setup script.
#
# OpenCode is pre-installed in the Leash default coder image.
# This script asserts it is available and exits with a clear error if not.

set -euo pipefail

if ! command -v opencode &>/dev/null; then
  echo "[agent-start/opencode] ERROR: opencode CLI not found." >&2
  echo "[agent-start/opencode] This profile requires the Leash coder image (public.ecr.aws/s5i7k8t3/strongdm/coder)." >&2
  exit 1
fi

echo "[agent-start/opencode] opencode is available: $(opencode --version 2>/dev/null || echo 'unknown version')"
