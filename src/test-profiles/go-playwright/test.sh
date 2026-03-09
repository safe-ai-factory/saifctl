#!/bin/sh
# Test Runner Container Entrypoint — Go / playwright-go runner
#
# CONTRACT — this script defines the interface between the Orchestrator and the Test Runner image.
# It is always bind-mounted into the container at /usr/local/bin/test.sh (read-only).
# Override by passing --test-script <path> to run / feat:continue / feat:test / design-fail2pass.
#
# Environment variables provided by the Orchestrator (all required):
#
#   FACTORY_TARGET_URL    URL of the application under test (web server).
#   FACTORY_SIDECAR_URL   URL of the HTTP sidecar that wraps CLI command execution.
#   FACTORY_CHANGE_NAME   Name of the OpenSpec change being tested.
#   FACTORY_TESTS_DIR     Absolute path inside the container where test files are mounted.
#   FACTORY_OUTPUT_FILE   Absolute path where this script must write the JUnit XML report.

set -e

echo "[test-runner] FACTORY_TARGET_URL:   ${FACTORY_TARGET_URL}"
echo "[test-runner] FACTORY_SIDECAR_URL:  ${FACTORY_SIDECAR_URL}"
echo "[test-runner] FACTORY_CHANGE_NAME:  ${FACTORY_CHANGE_NAME}"
echo "[test-runner] FACTORY_TESTS_DIR:    ${FACTORY_TESTS_DIR}"
echo "[test-runner] FACTORY_OUTPUT_FILE:  ${FACTORY_OUTPUT_FILE}"

echo "[test-runner] public spec count:  $(find "${FACTORY_TESTS_DIR}/public" -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"
echo "[test-runner] hidden spec count:  $(find "${FACTORY_TESTS_DIR}/hidden" -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"

cd "${FACTORY_TESTS_DIR}"

go test -v ./... 2>&1 | go-junit-report -set-exit-code > "${FACTORY_OUTPUT_FILE}"
