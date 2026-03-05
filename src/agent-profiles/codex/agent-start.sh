#!/bin/bash
# Codex agent setup script.
#
# Codex is pre-installed in the Leash default coder image.
# This script asserts it is available and exits with a clear error if not.

set -euo pipefail

if ! command -v codex &>/dev/null; then
  echo "[agent-start/codex] ERROR: codex CLI not found." >&2
  echo "[agent-start/codex] This profile requires the Leash coder image (public.ecr.aws/s5i7k8t3/strongdm/coder)." >&2
  exit 1
fi

echo "[agent-start/codex] codex is available: $(codex --version 2>/dev/null || echo 'unknown version')"
