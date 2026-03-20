#!/bin/sh
# Test Runner Container Entrypoint — Go / go test runner
#
# CONTRACT — this script defines the interface between the Orchestrator and the Test Runner image.
# It is always bind-mounted into the container at /usr/local/bin/test.sh (read-only).
# Override by passing --test-script <path> to run / resume / run test / design-fail2pass.
#
# Environment variables provided by the Orchestrator (all required):
#
#   SAIFAC_TARGET_URL    URL of the application under test (web server or sidecar).
#   SAIFAC_SIDECAR_URL   URL of the HTTP sidecar that wraps CLI command execution.
#   SAIFAC_FEATURE_NAME  Name of the Saifac feature being tested.
#   SAIFAC_TESTS_DIR     Absolute path inside the container where test files are mounted.
#                         Default: /tests
#                         Subdirectories:
#                           /tests/public/      — public spec files (*_test.go, visible to agent)
#                           /tests/hidden/      — hidden spec files (*_test.go, not exposed)
#                           /tests/helpers.go   — shared test helpers
#                           /tests/infra_test.go — infra health-check (always present)
#   SAIFAC_OUTPUT_FILE   Absolute path where this script must write the JUnit XML report.
#
# Exit code contract:
#   0  — all tests passed
#   non-zero — one or more tests failed (or runner error)
#
# Requires: go, go-junit-report (installed in the Docker image)

set -e

echo "[test-runner] SAIFAC_TARGET_URL:   ${SAIFAC_TARGET_URL}"
echo "[test-runner] SAIFAC_SIDECAR_URL:  ${SAIFAC_SIDECAR_URL}"
echo "[test-runner] SAIFAC_FEATURE_NAME: ${SAIFAC_FEATURE_NAME}"
echo "[test-runner] SAIFAC_TESTS_DIR:    ${SAIFAC_TESTS_DIR}"
echo "[test-runner] SAIFAC_OUTPUT_FILE:  ${SAIFAC_OUTPUT_FILE}"

echo "[test-runner] public spec count:  $(find "${SAIFAC_TESTS_DIR}/public" -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"
echo "[test-runner] hidden spec count:  $(find "${SAIFAC_TESTS_DIR}/hidden" -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"

cd "${SAIFAC_TESTS_DIR}"

# go test outputs a plain text report; pipe through go-junit-report to get JUnit XML.
# go-junit-report reads stdin and writes to stdout.
go test -v ./... 2>&1 | go-junit-report -set-exit-code > "${SAIFAC_OUTPUT_FILE}"
