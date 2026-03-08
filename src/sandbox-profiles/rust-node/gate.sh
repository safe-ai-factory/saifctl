#!/bin/bash
# rust-node sandbox profile — default gate script.
# Runs the standard Rust toolchain checks: compilation check, linter, and tests.
set -euo pipefail
cd /workspace

# ALWAYS tell user to use custom gate script
# NOTE: Best practice is to define a single custom command that runs ALL the tests, lints, and checks
#       that you want. That way, AI agent needs to run only one command to validate the code.
echo "[factory-gate] WARNING: Running DEFAULT gate (cargo check + clippy + test)."
echo "[factory-gate] Define a custom --gate-script with more checks for better results."

echo "[factory-gate] Running cargo check..."
cargo check
echo "[factory-gate] Running cargo clippy..."
cargo clippy -- -D warnings
echo "[factory-gate] Running cargo test..."
cargo test
echo "[factory-gate] Gate PASSED."
