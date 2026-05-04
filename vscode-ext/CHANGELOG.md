# Changelog

All notable changes to the SaifCTL VS Code extension are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the extension follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The extension and the saifctl CLI ship as **independent SemVer trains**
(per saifctl's release-readiness Decision D-02). Each release of this
extension declares a minimum compatible CLI version (`MIN_CLI_VERSION`)
and probes `saifctl --version` at activation; on mismatch the user is
prompted to install or upgrade.

## [Unreleased]

## [0.1.0] — Initial public release

First public marketplace release.

### Added

- Sidebar tree view of saifctl features and runs.
- One-click actions to start, pause, resume, stop, fork, inspect, and
  delete runs from the sidebar.
- Per-run config view, diff inspection, and chat timeline.
- Manage LLM API keys via VS Code's secret storage.
- Goto-feature-from-run navigation.
- Compatibility probe at activation: shells `saifctl --version` and
  prompts the user if the installed CLI is older than `MIN_CLI_VERSION`.

### Compatibility

- Requires `@safe-ai-factory/saifctl` ≥ `0.1.0` on `PATH`.
- VS Code engine: `^1.86.0`.
