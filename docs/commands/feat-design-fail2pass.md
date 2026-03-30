# saifctl feat design-fail2pass

Validate generated tests. Runs tests against main; at least one feature test must fail (third step of design workflow).

Runs the full test suite against the current codebase (without any implementation changes). Expects at least one feature test to fail, proving the tests exercise something unimplemented. Partial overlap is OK — some tests may pass if they describe behavior that already exists.

Use this after `feat design-tests` to verify the tests are valid before starting the iterative agent loop. The full `feat design` command includes this step automatically.

## Usage

```bash
saifctl feat design-fail2pass [options]
saifctl feature design-fail2pass [options]
```

## Requirements

- **Docker deamon** - This step starts up containers to verify written tests

## Arguments

| Argument             | Alias | Type   | Description                                                                                     |
| -------------------- | ----- | ------ | ----------------------------------------------------------------------------------------------- |
| `--name`             | `-n`  | string | Feature name (kebab-case). Prompts with a list if omitted.                                      |
| `--saifctl-dir`       | —     | string | Path to saifctl directory (default: `saifctl`)                                                    |
| `--project-dir`      | —     | string | Project directory (default: current directory)                                          |
| `--project`          | `-p`  | string | Project name override (default: package.json "name")                                            |
| `--sandbox-base-dir` | —     | string | Base directory for sandbox entries (default: `/tmp/saifctl/sandboxes`)                    |
| `--profile`          | —     | string | Sandbox profile (default: node-pnpm-python). Sets defaults for startup-script and stage-script. |
| `--test-profile`     | —     | string | Test profile id (default: node-vitest)                                                          |
| `--test-script`      | —     | string | Path to a shell script that overrides test.sh inside the Test Runner container.                 |
| `--test-image`       | —     | string | Test runner Docker image tag (default: saifctl-test-\<profile\>:latest)                         |
| `--startup-script`   | —     | string | Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.)     |
| `--stage-script`     | —     | string | Path to a shell script mounted into the staging container. Must handle app startup.             |

## Examples

Interactive (prompts for feature name):

```bash
saifctl feat design-fail2pass
```

With name:

```bash
saifctl feat design-fail2pass -n add-login
```

Change language or framework for the sandbox container (e.g. your codebse is in Golang):

```bash
saifctl feat design-fail2pass --profile go-node
```

Change language or framework for the test runner (e.g. if you wrote tests in Golang):

```bash
saifctl feat design-fail2pass --test-profile go-gotest
```

## What it does

1. Creates an isolated sandbox with the current codebase (no patches).
2. Spins up the staging container and test runner container.
3. Runs the full test suite (including hidden tests).
4. Succeeds if at least one feature test fails — confirms the tests exercise unimplemented behavior.

If all tests pass, the command exits with an error. Either the feature is already implemented or the tests are invalid.

## See also

- [feat design](feat-design.md) — Full design flow (spec gen + tests design + validate tests)
- [feat run](feat-run.md) — Implement specs with the agent loop (run after design)
- [feat design-specs](feat-design-specs.md) — Spec gen only (first step)
- [feat design-tests](feat-design-tests.md) — Generate tests from specs (second step)
- [feat new](feat-new.md) — Create a new feature
