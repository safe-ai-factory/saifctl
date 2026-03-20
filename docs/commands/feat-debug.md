# saifac feat debug

Spin up the staging container and stream its logs (Ctrl+C to stop).

Useful for diagnosing startup failures: installation script output, sidecar boot errors, missing binaries, environment issues, etc. No test runner, no agent loop — only the staging container. Staging config (sidecarPort, sidecarPath, build) comes from `saifac/config.ts` (`environments.staging.app`).

Press **Ctrl+C** to stop and clean up (removes the network, staging image, and sandbox).

## Usage

```bash
saifac feat debug [options]
saifac feature debug [options]
```

## Requirements

- **Docker daemon** — Starts the staging container (config from `saifac/config.ts` `environments.staging.app`)
  — Must have run `saifac feat design` first (or at least have `tests.json` in the feature dir)

## Arguments

| Argument             | Alias | Type   | Description                                                                                  |
| -------------------- | ----- | ------ | -------------------------------------------------------------------------------------------- |
| `--name`             | `-n`  | string | Feature name (kebab-case). Prompts with a list if omitted.                                   |
| `--saifac-dir`       | —     | string | Path to saifac directory (default: `saifac`)                                                 |
| `--project-dir`      | —     | string | Project directory (default: current working directory)                                       |
| `--project`          | `-p`  | string | Project name override (default: package.json "name")                                         |
| `--sandbox-base-dir` | —     | string | Base directory for sandbox entries (default: `/tmp/saifac`)                         |
| `--profile`          | —     | string | Sandbox profile. Sets defaults for startup-script and stage-script.                          |
| `--startup-script`   | —     | string | Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.). |
| `--stage-script`     | —     | string | Path to a shell script mounted into the staging container. Must handle app startup.          |

## Examples

Interactive (prompts for feature name):

```bash
saifac feat debug
```

With name:

```bash
saifac feat debug -n add-login
```

Use a different sandbox profile (e.g. Python-only):

```bash
saifac feat debug -n add-login --profile python-pip
```

Custom startup script (e.g. pip install):

```bash
saifac feat debug -n add-login --startup-script ./scripts/my-startup.sh
```

## What it does

1. Creates an isolated sandbox with the current codebase (no patches).
2. Builds/uses the staging image (config from `saifac/config.ts` `environments.staging.app`).
3. Starts the staging container and streams stdout/stderr live.
4. Waits until Ctrl+C; then cleans up network, images, and sandbox.

## See also

- [Environments and Infrastructure](../services.md) — How staging and provisioners work
- [feat design](feat-design.md) — Generate specs and tests (run first)
- [feat run](feat-run.md) — Implement specs with the agent loop
- [feat design-fail2pass](feat-design-fail2pass.md) — Validate tests against main
- [Commands](README.md) — Full workflow
