// Example test — a runnable starting point you EDIT IN PLACE.
//
// Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
// design-tests`. Unlike helpers.go / infra_test.go, this file is meant to
// be edited: keep it as a working reference for the go test format, or
// replace its body with your real assertion. The scaffold skips this file
// when it already exists; pass `--force` to overwrite.
//
// What this demonstrates:
//   - Importing the shared transport from the helpers package
//   - Calling ExecSidecar(cmd, args, env) to run a command in the staging container
//   - Asserting on ExitCode and Stdout
//
// Why it passes by default: every saifctl staging container ships a sidecar
// that exposes the workspace shell, and `echo example-ok` is reliably present.
// Replace this with whatever invariant you actually want gated.
package example_test

import (
	"strings"
	"testing"

	helpers "github.com/placeholder/factory-tests/helpers"
)

func TestExampleRunsNoopInStagingContainer(t *testing.T) {
	result, err := helpers.ExecSidecar("echo", []string{"example-ok"}, nil)
	if err != nil {
		t.Fatalf("staging echo failed: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d (stderr: %q)", result.ExitCode, result.Stderr)
	}
	if strings.TrimSpace(result.Stdout) != "example-ok" {
		t.Errorf("expected stdout 'example-ok', got %q", result.Stdout)
	}
}
