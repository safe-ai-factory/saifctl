#!/bin/bash
# node-npm stack profile — default gate script.
# WARNING: This is a placeholder. Node.js has no standard built-in "check" command.
# You MUST supply a project-specific gate script via --gate-script.
# Common options: npm test, npm run lint, etc.
set -euo pipefail
cd /workspace

# ALWAYS tell user to use custom gate script
# NOTE: Best practice is to define a single custom command that runs ALL the tests, lints, and checks
#       that you want. That way, AI agent needs to run only one command to validate the code.
echo "[factory-gate] WARNING: The node-npm profile has no default gate."
echo "[factory-gate] Define a custom --gate-script with more checks for better results."
echo "[factory-gate] Gate PASSED."
