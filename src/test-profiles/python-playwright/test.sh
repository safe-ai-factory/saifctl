#!/bin/sh
# Test Runner Container Entrypoint — Python / pytest-playwright runner
#
# CONTRACT — this script defines the interface between the Orchestrator and the Test Runner image.
# It is always bind-mounted into the container at /usr/local/bin/test.sh (read-only).
# Override by passing --test-script <path> to feat:run / feat:continue / feat:assess / feat:fail2pass.
#
# Environment variables provided by the Orchestrator (all required):
#
#   FACTORY_TARGET_URL    URL of the application under test (web server or sidecar).
#   FACTORY_SIDECAR_URL   URL of the HTTP sidecar that wraps CLI command execution.
#   FACTORY_CHANGE_NAME   Name of the OpenSpec change being assessed.
#   FACTORY_TESTS_DIR     Absolute path inside the container where test files are mounted.
#                         Default: /tests
#                         Subdirectories:
#                           /tests/public/       — public spec files (test_*.py, visible to agent)
#                           /tests/hidden/       — hidden spec files (test_*.py, not exposed)
#                           /tests/helpers.py    — shared helpers
#                           /tests/test_infra.py — infra health-check (always present)
#   FACTORY_OUTPUT_FILE   Absolute path where this script must write the JUnit XML report.
#
# Exit code contract:
#   0  — all tests passed
#   non-zero — one or more tests failed (or runner error)

set -e

echo "[test-runner] FACTORY_TARGET_URL:   ${FACTORY_TARGET_URL}"
echo "[test-runner] FACTORY_SIDECAR_URL:  ${FACTORY_SIDECAR_URL}"
echo "[test-runner] FACTORY_CHANGE_NAME:  ${FACTORY_CHANGE_NAME}"
echo "[test-runner] FACTORY_TESTS_DIR:    ${FACTORY_TESTS_DIR}"
echo "[test-runner] FACTORY_OUTPUT_FILE:  ${FACTORY_OUTPUT_FILE}"

echo "[test-runner] public spec count:  $(find "${FACTORY_TESTS_DIR}/public" -name 'test_*.py' 2>/dev/null | wc -l | tr -d ' ')"
echo "[test-runner] hidden spec count:  $(find "${FACTORY_TESTS_DIR}/hidden" -name 'test_*.py' 2>/dev/null | wc -l | tr -d ' ')"

# PLAYWRIGHT_BASE_URL is the Playwright-native env var used by pytest-playwright fixtures.
export PLAYWRIGHT_BASE_URL="${FACTORY_TARGET_URL}"

exec pytest \
  "${FACTORY_TESTS_DIR}" \
  --junitxml="${FACTORY_OUTPUT_FILE}" \
  -v \
  -p no:cacheprovider \
  --browser chromium
