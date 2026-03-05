#!/bin/bash
# Claude Code agent setup script.
#
# Claude Code is pre-installed in the Leash default coder image.
# This script asserts it is available and exits with a clear error if not.

set -euo pipefail

if ! command -v claude &>/dev/null; then
  echo "[agent-start/claude] ERROR: claude CLI not found." >&2
  echo "[agent-start/claude] This profile requires the Leash coder image (public.ecr.aws/s5i7k8t3/strongdm/coder)." >&2
  exit 1
fi

echo "[agent-start/claude] claude is available: $(claude --version 2>/dev/null || echo 'unknown version')"
