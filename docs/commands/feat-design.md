# saifac feat design

Generate specs and tests from a feature's proposal (full design workflow):

1. Produces enriched specs from `proposal.md`.
2. Generates a test plan (`tests.md`) and test catalog (`tests.json`) from those specs.
3. Writes tests (e.g. `*.spec.ts`).
4. Validates the written tests run.

Equivalent to running:

```bash
saifac feat design-specs
saifacac feat design-tests
saifacac feat design-fail2pass
```

## Usage

```bash
saifac feat design [options]
saifac feature design [options]
```

## Requirements

- **Docker deamon** - This command starts up containers to verify written tests

## Arguments

| Argument             | Alias | Type    | Description                                                                                                                                                     |
| -------------------- | ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`             | `-n`  | string  | Feature name (kebab-case). Prompts with a list if omitted.                                                                                                      |
| `--yes`              | `-y`  | boolean | Non-interactive mode. Requires `--name`. Skips confirm when designer output exists; assumes redo.                                                               |
| `--force`            | `-f`  | boolean | Always re-run the designer and overwrite existing test files, without prompting.                                                                                |
| `--designer`         | —     | string  | Designer profile for spec generation (default: shotgun)                                                                                                         |
| `--model`            | —     | string  | LLM model. Single global or comma-separated `agent=model`. At most one global. See [models.md](../models.md).                                                   |
| `--base-url`         | —     | string  | LLM base URL. Single global or comma-separated `agent=url` (e.g. `http://localhost:11434/v1` or `pr-summarizer=https://api.openai.com/v1`). At most one global. |
| `--saifac-dir`       | —     | string  | Path to saifac directory (default: `saifac`)                                                                                                                    |
| `--project-dir`      | —     | string  | Project directory (default: current working directory)                                                                                                          |
| `--project`          | `-p`  | string  | Project name override for the indexer (default: package.json "name")                                                                                            |
| `--test-profile`     | —     | string  | Test profile id (default: node-vitest)                                                                                                                          |
| `--indexer`          | —     | string  | Indexer profile for codebase search (default: shotgun). Pass `none` to disable.                                                                                 |
| `--sandbox-base-dir` | —     | string  | Base directory for sandbox entries (default: `/tmp/saifac`)                                                                                            |
| `--profile`          | —     | string  | Sandbox profile (default: node-pnpm-python). Sets defaults for startup-script and stage-script.                                                                 |
| `--test-script`      | —     | string  | Path to a shell script that overrides test.sh inside the Test Runner container.                                                                                 |
| `--test-image`       | —     | string  | Test runner Docker image tag (default: saifac-test-\<profile\>:latest)                                                                                         |
| `--startup-script`   | —     | string  | Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.)                                                                     |
| `--stage-script`     | —     | string  | Path to a shell script mounted into the staging container. Must handle app startup.                                                                             |

## Examples

Design a feature (prompts for name if multiple features exist):

```bash
saifac feat design
saifacac feat design -n add-login
```

Force re-run of the designer (overwrite existing spec files without prompting):

```bash
saifacac feat design -f
```

Use a custom project directory (e.g. when running from a parent monorepo):

```bash
saifacac feat design --project-dir ./packages/my-app
```

Use a different designer or indexer:

```bash
saifacac feat design --designer shotgun --indexer shotgun
saifac feat design --indexer none
```

Use a specific model for the full design pipeline:

```bash
saifac feat design --model anthropic/claude-3-5-sonnet-latest
```

Override individual agents (e.g. stronger planner, cheaper test coder):

```bash
saifac feat design --model tests-planner=anthropic/claude-opus-4-5,tests-writer=openai/gpt-4o-mini
```

Change language or framework for the sandbox container (e.g. your codebse is in Golang):

```bash
saifacac feat design-fail2pass --profile go-node
```

Change language or framework for the test runner (e.g. if you wrote tests in Golang):

```bash
saifac feat design-fail2pass --test-profile go-gotest
```

## What it does

1. Optionally runs `feat design-discovery` (When discovery tools / MCPs are configured) to gather context into `discovery.md`.
2. Runs `feat design-specs`: Runs Shotgun to enrich the specs in `saifac/features/<name>/`.
3. Runs `feat design-tests`: reads the specs and generates a test plan (`tests.md`) and catalog (`tests.json`), then implements the tests (e.g. `*.spec.ts`).
4. Runs `feat design-fail2pass`: verifies at least one feature test fails on the current codebase (Docker required).

To run only spec + test generation without Docker, use `feat design-specs` and `feat design-tests` individually.

## See also

- [LLM configuration](../models.md) — Model flags, agent names, auto-discovery, and tier env vars
- [feat run](feat-run.md) — Implement specs with the agent loop (run after design)
- [feat design-discovery](feat-design-discovery.md) — Gather context with MCP/tools (optional step before design-specs)
- [feat design-specs](feat-design-specs.md) — Spec gen only (first step; use when going step by step)
- [feat design-tests](feat-design-tests.md) — Generate tests from existing specs (second step of design workflow)
- [feat design-fail2pass](feat-design-fail2pass.md) — Verify tests only (third step)
- [feat new](feat-new.md) — Create a new feature
- [Designers](../designers/README.md)
- [Indexer](../indexer/README.md)
- [Test profiles](../test-profiles.md)
