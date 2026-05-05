#!/bin/sh
# Test Runner Container Entrypoint — Go / go test runner
#
# CONTRACT — this script defines the interface between the Orchestrator and the Test Runner image.
# It is always bind-mounted into the container at /usr/local/bin/test.sh (read-only).
# Override by passing --test-script <path> to run / resume / run test / design-fail2pass.
#
# Environment variables provided by the Orchestrator (all required):
#
#   SAIFCTL_TARGET_URL    URL of the application under test (web server or sidecar).
#   SAIFCTL_SIDECAR_URL   URL of the HTTP sidecar that wraps CLI command execution.
#   SAIFCTL_FEATURE_NAME  Name of the Saifctl feature being tested.
#   SAIFCTL_TESTS_DIR     Absolute path inside the container where test files are mounted.
#                         Default: /tests
#                         Layout depends on whether the orchestrator merged multiple
#                         test-scope sources (e.g. feature/tests + saifctl/tests):
#                           Single-source (the common case) — flat layout:
#                             /tests/public/         — public spec files (*_test.go, visible to agent)
#                             /tests/hidden/         — hidden spec files (*_test.go, not exposed)
#                             /tests/helpers.go      — shared test helpers
#                             /tests/infra_test.go   — infra health-check (always present)
#                           Multi-source — per-label subtrees:
#                             /tests/<label>/public/         — same content, namespaced
#                             /tests/<label>/hidden/
#                             /tests/<label>/helpers.go      — per-source, no shared singleton
#                             /tests/<label>/infra_test.go
#                         Either way, `go test ./...` recurses and discovers them.
#   SAIFCTL_OUTPUT_FILE   Absolute path where this script must write the JUnit XML report.
#
# Exit code contract:
#   0  — all tests passed
#   non-zero — one or more tests failed (or runner error)
#
# Requires: go, go-junit-report (installed in the Docker image)

set -e

echo "[test-runner] SAIFCTL_TARGET_URL:   ${SAIFCTL_TARGET_URL}"
echo "[test-runner] SAIFCTL_SIDECAR_URL:  ${SAIFCTL_SIDECAR_URL}"
echo "[test-runner] SAIFCTL_FEATURE_NAME: ${SAIFCTL_FEATURE_NAME}"
echo "[test-runner] SAIFCTL_TESTS_DIR:    ${SAIFCTL_TESTS_DIR}"
echo "[test-runner] SAIFCTL_OUTPUT_FILE:  ${SAIFCTL_OUTPUT_FILE}"

echo "[test-runner] public spec count:  $(find "${SAIFCTL_TESTS_DIR}" -path '*/public/*' -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"
echo "[test-runner] hidden spec count:  $(find "${SAIFCTL_TESTS_DIR}" -path '*/hidden/*' -name '*_test.go' 2>/dev/null | wc -l | tr -d ' ')"

cd "${SAIFCTL_TESTS_DIR}"

# go test outputs a plain text report; pipe through go-junit-report to get JUnit XML.
# go-junit-report reads stdin and writes to stdout.
go test -v ./... 2>&1 | go-junit-report -set-exit-code > "${SAIFCTL_OUTPUT_FILE}"
