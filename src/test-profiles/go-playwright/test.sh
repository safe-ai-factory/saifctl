#!/bin/sh
# Test Runner Container Entrypoint — Go / playwright-go runner
#
# CONTRACT — this script defines the interface between the Orchestrator and the Test Runner image.
# It is always bind-mounted into the container at /usr/local/bin/test.sh (read-only).
# Override by passing --test-script <path> to run / resume / run test / design-fail2pass.
#
# Environment variables provided by the Orchestrator (all required):
#
#   SAIFCTL_TARGET_URL    URL of the application under test (web server).
#   SAIFCTL_SIDECAR_URL   URL of the HTTP sidecar that wraps CLI command execution.
#   SAIFCTL_FEATURE_NAME  Name of the Saifctl feature being tested.
#   SAIFCTL_TESTS_DIR     Absolute path inside the container where test files are mounted.
#   SAIFCTL_OUTPUT_FILE   Absolute path where this script must write the JUnit XML report.

set -e

echo "[test-runner] SAIFCTL_TARGET_URL:   ${SAIFCTL_TARGET_URL}"
echo "[test-runner] SAIFCTL_SIDECAR_URL:  ${SAIFCTL_SIDECAR_URL}"
echo "[test-runner] SAIFCTL_FEATURE_NAME: ${SAIFCTL_FEATURE_NAME}"
echo "[test-runner] SAIFCTL_TESTS_DIR:    ${SAIFCTL_TESTS_DIR}"
echo "[test-runner] SAIFCTL_OUTPUT_FILE:  ${SAIFCTL_OUTPUT_FILE}"

echo "[test-runner] public spec count:  $(find "${SAIFCTL_TESTS_DIR}/public" -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"
echo "[test-runner] hidden spec count:  $(find "${SAIFCTL_TESTS_DIR}/hidden" -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"

cd "${SAIFCTL_TESTS_DIR}"

go test -v ./... 2>&1 | go-junit-report -set-exit-code > "${SAIFCTL_OUTPUT_FILE}"
