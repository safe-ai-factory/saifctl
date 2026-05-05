// Example test — a runnable starting point you EDIT IN PLACE.
//
// Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
// design-tests`. Unlike helpers.rs / infra_test.rs, this file is meant to
// be edited: keep it as a working reference for the cargo test format, or
// replace its body with your real assertion. The scaffold skips this file
// when it already exists; pass `--force` to overwrite.
//
// What this demonstrates:
//   - Importing the shared transport from the helpers module
//   - Calling exec_sidecar(cmd, args, env) to run a command in the staging container
//   - Asserting on exit_code and stdout
//
// Why it passes by default: every saifctl staging container ships a sidecar
// that exposes the workspace shell, and `echo example-ok` is reliably present.
// Replace this with whatever invariant you actually want gated.

use std::collections::HashMap;

use crate::helpers::exec_sidecar;

#[test]
fn example_runs_noop_in_staging_container() {
    let result =
        exec_sidecar("echo", &["example-ok"], HashMap::new()).expect("staging echo failed");
    assert_eq!(
        result.exit_code, 0,
        "staging echo failed (stderr: {})",
        result.stderr
    );
    assert_eq!(result.stdout.trim(), "example-ok");
}
