// Example test — a runnable starting point you EDIT IN PLACE.
//
// Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
// design-tests`. Unlike helpers.rs / infra_test.rs, this file is meant to
// be edited: keep it as a working reference for the rust-playwright format,
// or replace its body with your real assertion. The scaffold skips this
// file when it already exists; pass `--force` to overwrite.
//
// What this demonstrates:
//   - Launching a Playwright browser via `new_page()` (async)
//   - Navigating to `base_url()` (the staging app)
//   - Asserting on response status
//
// If your project doesn't expose an HTTP service in the staging container,
// delete this file and use `exec_sidecar` from helpers.rs instead (CLI-style
// checks, like the rust-rusttest example).

use crate::helpers::{base_url, new_page};

#[tokio::test]
async fn example_staging_app_responds_at_root() {
    let (_pw, browser, page) = new_page().await.expect("failed to open browser page");
    let response = page
        .goto_builder(&base_url())
        .goto()
        .await
        .expect("page.goto failed");
    let status = response
        .status()
        .expect("could not read response status");
    assert!(
        (200..400).contains(&status),
        "expected 2xx/3xx, got {}",
        status,
    );
    browser.close().await.ok();
}
