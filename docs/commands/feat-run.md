# saifac feat run

Start an agent to implement the specs. Runs until it passes your tests.

Workflow:

- Creates an isolated sandbox.
- Runs the coder agent (e.g. OpenHands) in a loop.
- Runs tests against the code changes.
- Continues until all tests pass or max runs are exceeded.

## Usage

```bash
saifac feat run [options]
saifac feature run [options]
```

## Requirements

- **Docker daemon** - Starts the coder container, staging container, and test runner.
- **Feature with tests** - Must have run `saifac feat design` first.
- **LLM API key**

## Arguments

| Argument               | Alias | Type    | Description                                                                                                                                                         |
| ---------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`               | `-n`  | string  | Feature name (kebab-case). Prompts with a list if omitted.                                                                                                          |
| `--saifac-dir`         | —     | string  | Path to saifac directory (default: `saifac`)                                                                                                                       |
| `--project-dir`        | —     | string  | Project directory (default: current working directory)                                                                                                              |
| `--project`            | `-p`  | string  | Project name override (default: package.json "name")                                                                                                                |
| `--test-profile`       | —     | string  | Test profile id (default: node-vitest)                                                                                                                              |
| `--sandbox-base-dir`   | —     | string  | Base directory for sandbox entries (default: `/tmp/saifac/sandboxes`)                                                                                        |
| `--profile`            | —     | string  | Sandbox profile (default: node-pnpm-python). Sets defaults for startup-script and stage-script.                                                                     |
| `--test-script`        | —     | string  | Path to a shell script that overrides test.sh inside the Test Runner container.                                                                                     |
| `--test-image`         | —     | string  | Test runner Docker image tag (default: saifac-test-\<profile\>:latest)                                                                                             |
| `--startup-script`     | —     | string  | Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.)                                                                         |
| `--stage-script`       | —     | string  | Path to a shell script mounted into the staging container. Must handle app startup.                                                                                 |
| `--gate-script`        | —     | string  | Path to a shell script run inside Leash after each round. Defaults to profile gate.                                                                                 |
| `--agent`              | —     | string  | Agent profile (default: openhands). Resolves default agent install/run scripts and the profile gate script.                                                         |
| `--agent-script`       | —     | string  | Path to the coding agent script. Overrides profile default.                                                                                                         |
| `--agent-install-script` | —     | string  | Path to the one-time agent install script. Overrides profile default.                                                                                               |
| `--max-runs`           | —     | string  | Max full pipeline runs before giving up (default: 5)                                                                                                                |
| `--test-retries`       | —     | string  | How many times to retry when tests fail (default: 1)                                                                                                                |
| `--resolve-ambiguity`  | —     | string  | How to handle spec ambiguity on failures. `ai` \| `prompt` \| `off` (default: `ai`)                                                                                 |
| `--dangerous-debug`    | —     | boolean | Skip Leash; run OpenHands directly on the host. Use only for development/debugging.                                                                                 |
| `--cedar`              | —     | string  | Absolute path to Cedar policy file for Leash (default: `src/orchestrator/policies/default.cedar` in the package)                                                  |
| `--coder-image`        | —     | string  | Docker image for the coder container (default: from `--profile`)                                                                                                    |
| `--gate-retries`       | —     | string  | Max gate retries per run (default: 10)                                                                                                                              |
| `--no-reviewer`        | —     | boolean | Disable the semantic AI reviewer. Use when Argus is unavailable or to speed up runs.                                                                                |
| `--agent-env`          | —     | string  | Extra env for the agent container. Repeatable; each use is `KEY=VALUE` or comma-separated `KEY1=VAL1,KEY2=VAL2`. Values cannot contain commas.                     |
| `--agent-env-file`     | —     | string  | Single path or comma-separated paths to .env file(s). Later overrides earlier for duplicate keys.                                                                   |
| `--agent-log-format`   | —     | string  | How to parse agent stdout. `openhands` \| `raw` (default: from agent profile)                                                                                       |
| `--storage`            | —     | string  | Where run state is stored. Bare global (`local`, `none`, `file:///path`, `s3`, `s3://bucket/prefix`) or per-key `runs=…` / `tasks=…` with the same value forms; comma-separated mixes. Feat run uses the `runs` key (default: local). `none` disables persistence. |
| `--push`               | —     | string  | Push feature branch after success. Accepts Git URL, slug (owner/repo), or remote name.                                                                              |
| `--pr`                 | —     | boolean | Open a Pull Request after pushing. Requires `--push` and provider token env var.                                                                                    |
| `--git-provider`       | —     | string  | Git hosting provider for push/PR. `github` \| `gitlab` \| `bitbucket` \| `azure` \| `gitea` (default: `github`)                                                     |
| `--model`              | —     | string  | LLM model. Single global or comma-separated `agent=model` (e.g. `anthropic/claude-opus-4-5` or `pr-summarizer=openai/gpt-4o-mini`). At most one global.             |
| `--base-url`           | —     | string  | LLM base URL. Single global (e.g. `http://localhost:11434/v1`) or comma-separated `agent=url` (e.g. `pr-summarizer=https://api.openai.com/v1`). At most one global. |
| `--verbose`            | `-v`  | boolean | Verbose CLI logging; also shows full `git commit` output (omits `-q`). Default: quiet.                                                                              |

## Examples

Interactive (prompts for feature name):

```bash
saifac feat run
```

With name:

```bash
saifac feat run -n add-login
```

Use a specific model:

```bash
saifac feat run -n add-login --model anthropic/claude-3-5-sonnet-latest
```

Resolve spec ambiguity with human confirmation:

```bash
saifac feat run -n add-login --resolve-ambiguity prompt
```

Skip Leash (run OpenHands on host; development/debugging only):

```bash
saifac feat run -n add-login --dangerous-debug
```

Use a custom coder image or agent:

```bash
saifac feat run -n add-login --coder-image my-saifac-coder:latest
saifac feat run -n add-login --agent aider --agent-log-format raw
```

Use custom run storage (S3, custom path):

```bash
# Disable persistence (no resume)
saifac feat run -n add-login --storage none
# Equivalent: --storage runs=none

# Custom local directory
saifac feat run -n add-login --storage runs=file:///tmp/my-runs

# S3 (requires SAIF_DEFAULT_S3_BUCKET) or full URI
saifac feat run -n add-login --storage runs=s3://my-bucket/runs?profile=dev&region=us-east-1
```

Push and open a PR after success:

```bash
saifac feat run -n add-login --push origin --pr
```

## What it does

1. Creates an isolated sandbox from the current codebase (rsync copy).
2. Starts the coder container (via Leash by default) or runs the agent on the host with `--dangerous-debug`.
3. In a loop: runs the agent → runs the gate script → assesses with the test runner. Repeats until tests pass or max runs are exceeded.
4. On failure due to spec ambiguity (when `--resolve-ambiguity` is `ai` or `prompt`), the Vague Specs Checker may update the spec and regenerate tests, then retry.
5. On success, optionally pushes the branch and opens a PR.
6. On failure, saves run state to `.saifac/runs/` and prints the `saifac run resume` command to resume.

## Resuming previous runs

- On failure, run state is saved to `.saifac/runs/`. Resume later with `saifac run resume <runId>`.

## Ambiguity in specs

When tests fail, the failure is not always the coding agent's fault. Sometimes the **specification is ambiguous**: the test-writing agents wrote tests that assume behavior the spec never stated, while the implementation agent chose a different, equally reasonable interpretation. When both "guess" differently, hidden tests fail even though the implementation may be correct.

The `--resolve-ambiguity` flag controls how the orchestrator handles this:

| Value            | Behavior                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ai** (default) | On each failure, a **Vague Specs Checker** (high-capability LLM) runs. If it decides the failure is due to spec ambiguity, it proposes a clarification; the orchestrator appends it to `specification.md`, regenerates tests, resets the attempt counter, and continues — all without human input. |
| **prompt**       | Same as `ai`, but when ambiguity is detected the orchestrator pauses and asks the human to confirm or edit the clarification before updating the spec.                                                                                                                                             |
| **off**          | Vague Specs Checker is disabled. All failures get a generic error message. Use when debugging or when you want no spec drift.                                                                                                                                                                      |

The Vague Specs Checker is implemented as a single LLM call that internally performs three conceptual steps:

1. **Detect** — Decide whether the failure was caused by an ambiguous spec (vs. a genuine implementation mistake).
2. **Clarify** — If ambiguous, propose a spec addition to disambiguate.
3. **Hint** — If genuine, produce a sanitized behavioral hint for the agent (without leaking holdout test details).

## See also

- [feat design](feat-design.md) — Generate specs and tests (run first)
- [feat design-fail2pass](feat-design-fail2pass.md) — Validate tests before running
- `saifac run resume <runId>` — Resume a failed run from storage
- [Semantic reviewer](../reviewer.md) — Reviewer configuration and `--no-reviewer`
- [Cedar access control](../leash-access-control.md) — Customize Leash policy
- [LLM configuration](../models.md) — Model flags, agent names, auto-discovery
- [All commands](README.md)
