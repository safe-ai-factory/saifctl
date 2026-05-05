// Example test — a runnable starting point you EDIT IN PLACE.
//
// Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
// design-tests`. Unlike helpers.go / infra_test.go, this file is meant to
// be edited: keep it as a working reference for the playwright-go format,
// or replace its body with your real assertion. The scaffold skips this
// file when it already exists; pass `--force` to overwrite.
//
// What this demonstrates:
//   - Importing the shared transport from the helpers package
//   - Hitting the staging app via HTTPRequest helper
//   - Asserting on response status
//
// If your project doesn't expose an HTTP service in the staging container,
// delete this file and use ExecSidecar from helpers.go instead (CLI-style
// checks, like the go-gotest example).
package example_test

import (
	"testing"

	helpers "github.com/placeholder/factory-tests/helpers"
)

func TestExampleStagingAppRespondsAtRoot(t *testing.T) {
	resp, err := helpers.HTTPRequest("GET", "/", nil, nil)
	if err != nil {
		t.Fatalf("staging app not reachable: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		t.Errorf("expected 2xx/3xx, got %d", resp.StatusCode)
	}
}
