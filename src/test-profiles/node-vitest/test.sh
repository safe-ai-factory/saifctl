#!/bin/sh
# Test Runner Container Entrypoint — TypeScript / Vitest runner
#
# CONTRACT — this script defines the interface between the Orchestrator and the Test Runner image.
# It is always bind-mounted into the container at /usr/local/bin/test.sh (read-only).
# Override by passing --test-script <path> to feat:run / feat:continue / feat:assess / feat:fail2pass.
#
# Environment variables provided by the Orchestrator (all required):
#
#   FACTORY_TARGET_URL    URL of the application under test (web server or sidecar).
#                         For CLI projects this is the sidecar URL.
#                         For web projects this is the application's base URL.
#
#   FACTORY_SIDECAR_URL   URL of the HTTP sidecar that wraps CLI command execution.
#                         Format: http://staging:<port><path>  (e.g. http://staging:8080/exec)
#                         Always defined — even for web projects — because the sidecar runs
#                         in every staging container.
#
#   FACTORY_CHANGE_NAME   Name of the OpenSpec change being assessed (e.g. "greet-cmd").
#
#   FACTORY_TESTS_DIR     Absolute path inside the container where test files are mounted.
#                         Default: /tests
#                         Subdirectories:
#                           /tests/public/       — public spec files (visible to agent)
#                           /tests/hidden/       — hidden spec files (not exposed to agent)
#                           /tests/helpers.ts    — shared test helpers imported by specs
#                           /tests/infra.spec.ts — infra health-check (always present)
#
#   FACTORY_OUTPUT_FILE   Absolute path where this script must write the test results file.
#                         Default: /test-runner-output/results.xml
#                         The Orchestrator reads this file after the container exits.
#                         The /test-runner-output directory is bind-mounted rw by the Orchestrator.
#
# Exit code contract:
#   0  — all tests passed
#   non-zero — one or more tests failed (or runner error)
#
# Output file format:
#   JUnit XML (standard format supported by all major test runners and CI systems).
#   Written to FACTORY_OUTPUT_FILE. If the runner crashes before producing output,
#   the file may be absent; the Orchestrator handles this gracefully.
#
# To use a custom test script:
#   Pass --test-script <path> to feat:run / feat:continue / feat:assess / feat:fail2pass.
#   Your script must read the env vars above, write JUnit XML to FACTORY_OUTPUT_FILE,
#   and exit 0 on pass / non-zero on failure.
#
# ─────────────────────────────────────────────────────────────────────────────

set -e

echo "[test-runner] FACTORY_TARGET_URL:   ${FACTORY_TARGET_URL}"
echo "[test-runner] FACTORY_SIDECAR_URL:  ${FACTORY_SIDECAR_URL}"
echo "[test-runner] FACTORY_CHANGE_NAME:  ${FACTORY_CHANGE_NAME}"
echo "[test-runner] FACTORY_TESTS_DIR:    ${FACTORY_TESTS_DIR}"
echo "[test-runner] FACTORY_OUTPUT_FILE:  ${FACTORY_OUTPUT_FILE}"

echo "[test-runner] public spec count:  $(find "${FACTORY_TESTS_DIR}/public" -name '*.spec.ts' 2>/dev/null | wc -l | tr -d ' ')"
echo "[test-runner] hidden spec count:  $(find "${FACTORY_TESTS_DIR}/hidden" -name '*.spec.ts' 2>/dev/null | wc -l | tr -d ' ')"

cd "${FACTORY_TESTS_DIR}"

# Run the tests and save the JUnit XML report to the output file.
exec npx vitest run \
  --root "${FACTORY_TESTS_DIR}" \
  --reporter=verbose \
  --reporter=junit \
  --outputFile="${FACTORY_OUTPUT_FILE}"
