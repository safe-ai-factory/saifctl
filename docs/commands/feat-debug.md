# saif feat debug

Spin up the staging container and stream its logs (Ctrl+C to stop).

Useful for diagnosing startup failures: installation script output, sidecar boot errors, missing binaries, environment issues, etc. No test runner, no agent loop — only the staging container and any ephemeral sidecars from `tests.json`.

Press **Ctrl+C** to stop and clean up (removes the network, staging image, and sandbox).

## Usage

```bash
saif feat debug [options]
saif feature debug [options]
```

## Requirements

- **Docker daemon** — Starts the staging container and any sidecars from `tests.json`
- **OpenSpec change** — Must have run `saif feat design` first (or at least have `tests.json` in the change dir)

## Arguments

| Argument               | Alias | Type   | Description                                                                                  |
| ---------------------- | ----- | ------ | -------------------------------------------------------------------------------------------- |
| `--name`               | `-n`  | string | Feature name (kebab-case). Prompts with a list if omitted.                                   |
| `--openspec-dir`       | —     | string | Path to openspec directory (default: `openspec`)                                             |
| `--project-dir`        | —     | string | Project directory (default: current working directory)                                       |
| `--project`            | `-p`  | string | Project name override (default: package.json "name")                                         |
| `--sandbox-base-dir`   | —     | string | Base directory for sandbox entries (default: `/tmp/factory-sandbox`)                         |
| `--profile`          | —     | string | Sandbox profile. Sets defaults for startup-script and stage-script.                           |
| `--startup-script`   | —     | string | Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.). |
| `--stage-script`     | —     | string | Path to a shell script mounted into the staging container. Must handle app startup.          |

## Examples

Interactive (prompts for feature name):

```bash
saif feat debug
```

With name:

```bash
saif feat debug -n add-login
```

Use a different sandbox profile (e.g. Python-only):

```bash
saif feat debug -n add-login --profile python-pip
```

Custom startup script (e.g. pip install):

```bash
saif feat debug -n add-login --startup-script ./scripts/factory-startup.sh
```

## What it does

1. Creates an isolated sandbox with the current codebase (no patches).
2. Builds/uses the staging image and any sidecar images from `tests.json`.
3. Starts the staging container and streams stdout/stderr live.
4. Waits until Ctrl+C; then cleans up network, images, and sandbox.

## See also

- [feat design](feat-design.md) — Generate specs and tests (run first)
- [feat run](feat-run.md) — Implement specs with the agent loop
- [feat design-fail2pass](feat-design-fail2pass.md) — Validate tests against main
- [Commands](README.md) — Full workflow
