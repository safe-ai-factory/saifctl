#!/usr/bin/env bash
# Intentionally failing gate for testing --gate-script wiring.
#
# coder-start.sh captures stdout+stderr and appends this output to the task on failure,
# so you should see these lines in logs and in the retry prompt.
#
# Usage (from your project root, path relative to --project-dir):
#   saifctl feat run -n <feature> --gate-script ./scripts/gate-dummy-fail.sh
#
# Tip: pair with --gate-retries 1 and --no-reviewer for a fast, deterministic failure loop.
set -u

echo "DUMMY_GATE_FAIL: This gate always fails (for testing)."
echo "DUMMY_GATE_FAIL: stdout line 2 — capture should include both lines."
echo "DUMMY_GATE_FAIL: stderr line" >&2
exit 42
