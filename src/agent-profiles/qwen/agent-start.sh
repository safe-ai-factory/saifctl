#!/bin/bash
# Qwen Coder agent setup script.
#
# Qwen is pre-installed in the Leash default coder image.
# This script asserts it is available and exits with a clear error if not.

set -euo pipefail

if ! command -v qwen &>/dev/null; then
  echo "[agent-start/qwen] ERROR: qwen CLI not found." >&2
  echo "[agent-start/qwen] This profile requires the Leash coder image (public.ecr.aws/s5i7k8t3/strongdm/coder)." >&2
  exit 1
fi

echo "[agent-start/qwen] qwen is available: $(qwen --version 2>/dev/null || echo 'unknown version')"
