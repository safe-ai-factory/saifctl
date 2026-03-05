#!/bin/bash
# python-uv-node stack profile — default gate script.
# WARNING: This is a placeholder. There is no universal Python "check" command.
# You MUST supply a project-specific gate script via --gate-script.
# Common options: uv run pytest, uv run ruff check ., etc.
set -euo pipefail
cd /workspace

# ALWAYS tell user to use custom gate script
# NOTE: Best practice is to define a single custom command that runs ALL the tests, lints, and checks
#       that you want. That way, AI agent needs to run only one command to validate the code.
echo "[factory-gate] WARNING: The python-uv-node profile has no default gate."
echo "[factory-gate] Define a custom --gate-script with more checks for better results."
echo "[factory-gate] Gate PASSED."
