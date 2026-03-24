# saifac run test

Run **tests only** for a **saved run** — the same code the agent had produced for that run — **without** running the coding agent again.

Use this when you want to check the saved work again after tweaking tests, or switching test setup. If tests pass, you can **push** or open a **PR** the same way as after a normal successful run (when you pass `--push` / `--pr`).

## Usage

```bash
saifac run test <runId> [options]
```

## Requirements

- **Docker daemon** — Same as [`feat run`](feat-run.md).
- **LLM API keys** — Same as `feat run`.

## Flags

By default, `run test` uses the same arguments as the original run.

To customize the run, you can use a subset of the same flags as [`feat run`](feat-run.md).

| Argument              | Alias | Type    | Description                                                                                    |
| --------------------- | ----- | ------- | ---------------------------------------------------------------------------------------------- |
| `runId`               | —     | string  | Saved run id (required). Get ids with `saifac run list` or `saifac run ls`.                    |
| `--project-dir`       | —     | string  | Project root (default: current directory).                                                     |
| `--saifac-dir`        | —     | string  | Saifac config folder (default: `saifac`).                                                      |
| `--project`           | `-p`  | string  | Project name override (default: `name` in package.json).                                       |
| `--sandbox-base-dir`  | —     | string  | Where disposable sandboxes are created (default under `/tmp/saifac/`; see [`feat run`](feat-run.md)). |
| `--profile`           | —     | string  | Sandbox profile (install/stage defaults).                                                      |
| `--test-profile`      | —     | string  | Which test profile to use (defaults follow the saved run unless you override).                 |
| `--test-script`       | —     | string  | Custom script path for running tests in the test container.                                    |
| `--test-image`        | —     | string  | Docker image for the test runner.                                                              |
| `--startup-script`    | —     | string  | Custom install script for the workspace copy.                                                  |
| `--stage-script`      | —     | string  | Custom script to start the app in staging.                                                     |
| `--test-retries`      | —     | string  | How many times to retry failing tests.                                                         |
| `--resolve-ambiguity` | —     | string  | On failure: `ai`, `prompt`, or `off` (whether to try to fix “ambiguous spec” failures).        |
| `--no-reviewer`       | —     | boolean | Turn off the semantic reviewer (Argus) after static checks.                                  |
| `--model`             | —     | string  | Model overrides (comma-separated `agent=model` allowed). |
| `--base-url`          | —     | string  | API base URL overrides (same comma rules as `--model`).                                          |
| `--storage`           | —     | string  | Where saved runs live (`local`, `file://…`, `s3`, etc.). See [Runs](../runs.md).               |
| `--push`              | —     | string  | After tests pass: where to push (remote name, URL, or `owner/repo`).                            |
| `--pr`                | —     | boolean | Open a PR after a push (needs `--push` and provider setup).                                    |
| `--git-provider`      | —     | string  | `github`, `gitlab`, `bitbucket`, `azure`, or `gitea` (default: `github`).                      |
| `--verbose`           | `-v`  | boolean | More detailed logs.                                                                            |

## Examples

Re-run tests with the same settings as when the run was saved:

```bash
saifac run test add-login-r1
```

If tests pass, push and open a PR:

```bash
saifac run test add-login-r1 --push origin --pr
```

Use a different test runner image:

```bash
saifac run test add-login-r1 --test-image factory-test-node-vitest:v2
```

Skip the “ambiguous spec” handling on failures:

```bash
saifac run test add-login-r1 --resolve-ambiguity off
```

Read the saved run from S3-backed storage:

```bash
saifac run test add-login-r1 --storage runs=s3://my-bucket/runs
```

## What it does

1. Loads the saved run for the id you gave.
2. Rebuilds a **temporary copy** of your project exactly as that run left it (same approach as [`run resume`](run-resume.md), but no agent loop).
3. Spins up the usual **sandbox** (isolated copy, staging, test runner) and runs the **test suite**.
5. On success, **applies the patch to your real repo** and can **push** or **open a PR** if you asked for that.

## Notes

- `run test` MUST be run in the same git context as the original run. Otherwise test fails with a clear error.

   Example: If you ran `feat run` on a branch with latest commit `abc123`, then the commit `abc123` must still exist when you run `run test`.
   
   We rely on git commits to faithfully reconstruct the workspace, while keeping the Run metadata light.

- If you set `--storage none` / `runs=none`, the CLI errors and exits non-zero (`Run storage is disabled (--storage none). Cannot test a stored run.`).

## See also

- [Runs](../runs.md) — How saved runs and storage work
- [`feat run`](feat-run.md) — Start a new implementation run
- [`run list`](run-list.md) — List saved run ids
- [`run info`](run-info.md) — View a saved run (summary JSON)
- [`run resume`](run-resume.md) — Continue with the agent after a failure
- [`run remove`](run-remove.md) — Delete a saved run
