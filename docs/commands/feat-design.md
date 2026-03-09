# saif feat design

Generate specs and tests from a feature's proposal (full design workflow):

1. Produces enriched specs from `proposal.md`.
2. Generates a test plan (`tests.md`) and test catalog (`tests.json`) from those specs.
3. Writes tests (e.g. `*.spec.ts`).
4. Validates the written tests run.

Equivalent to running:

```bash
saif feat design-specs
saif feat design-tests
saif feat design-fail2pass
```

## Usage

```bash
saif feat design [options]
saif feature design [options]
```

## Requirements

- **Docker deamon** - This command starts up containers to verify written tests

## Arguments

| Argument             | Alias | Type    | Description                                                                                                                                 |
| -------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`             | `-n`  | string  | Feature name (kebab-case). Prompts with a list if omitted.                                                                                  |
| `--yes`              | `-y`  | boolean | Non-interactive mode. Requires `--name`. Skips confirm when designer output exists; assumes redo.                                           |
| `--force`            | `-f`  | boolean | Always re-run the designer and overwrite existing test files, without prompting.                                                            |
| `--designer`         | —     | string  | Designer profile for spec generation (default: shotgun)                                                                                     |
| `--model`            | —     | string  | LLM model for all agents (`provider/model`, e.g. `anthropic/claude-3-5-sonnet-latest`). Auto-detected from available API keys when omitted. |
| `--base-url`         | —     | string  | LLM base URL override for all agents (e.g. `http://localhost:11434/v1` for Ollama).                                                         |
| `--agent-model`      | —     | string  | Per-agent model override. Format: `<agent>=<provider/model>`. Can be repeated. See [models.md](../models.md) for agent names.               |
| `--agent-base-url`   | —     | string  | Per-agent base URL override. Format: `<agent>=<url>`. Can be repeated.                                                                      |
| `--openspec-dir`     | —     | string  | Path to openspec directory (default: `openspec`)                                                                                            |
| `--project-dir`      | —     | string  | Project directory (default: current working directory)                                                                                      |
| `--project`          | `-p`  | string  | Project name override for the indexer (default: package.json "name")                                                                        |
| `--test-profile`     | —     | string  | Test profile id (default: node-vitest)                                                                                                      |
| `--indexer`          | —     | string  | Indexer profile for codebase search (default: shotgun). Pass `none` to disable.                                                             |
| `--sandbox-base-dir` | —     | string  | Base directory for sandbox entries (default: `/tmp/factory-sandbox`)                                                                        |
| `--profile`          | —     | string  | Sandbox profile (default: node-pnpm-python). Sets defaults for startup-script and stage-script.                                             |
| `--test-script`      | —     | string  | Path to a shell script that overrides test.sh inside the Test Runner container.                                                             |
| `--test-image`       | —     | string  | Test runner Docker image tag (default: factory-test-\<profile\>:latest)                                                                     |
| `--startup-script`   | —     | string  | Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.)                                                 |
| `--stage-script`     | —     | string  | Path to a shell script mounted into the staging container. Must handle app startup.                                                         |

## Examples

Design a feature (prompts for name if multiple changes exist):

```bash
saif feat design
saif feat design -n add-login
```

Force re-run of the designer (overwrite existing spec files without prompting):

```bash
saif feat design -f
```

Use a custom project directory (e.g. when running from a parent monorepo):

```bash
saif feat design --project-dir ./packages/my-app
```

Use a different designer or indexer:

```bash
saif feat design --designer shotgun --indexer shotgun
saif feat design --indexer none
```

Use a specific model for the full design pipeline:

```bash
saif feat design --model anthropic/claude-3-5-sonnet-latest
```

Override individual agents (e.g. stronger planner, cheaper test coder):

```bash
saif feat design \
  --agent-model tests-planner=anthropic/claude-opus-4-5 \
  --agent-model tests-writer=openai/gpt-4o-mini
```

Change language or framework for the sandbox container (e.g. your codebse is in Golang):

```bash
saif feat design-fail2pass --profile go-node
```

Change language or framework for the test runner (e.g. if you wrote tests in Golang):

```bash
saif feat design-fail2pass --test-profile go-gotest
```

## What it does

1. Runs `feat design-specs`: Runs Shotgun to enrich the specs in `openspec/changes/<name>/`.
2. Runs `feat design-tests`: reads the specs and generates a test plan (`tests.md`) and catalog (`tests.json`), then implements the tests (e.g. `*.spec.ts`).
3. Runs `feat design-fail2pass`: verifies at least one feature test fails on the current codebase (Docker required).

To run only spec + test generation without Docker, use `feat design-specs` and `feat design-tests` individually.

## See also

- [LLM configuration](../models.md) — Model flags, agent names, auto-discovery, and tier env vars
- [feat run](feat-run.md) — Implement specs with the agent loop (run after design)
- [feat design-specs](feat-design-specs.md) — Spec gen only (first step; use when going step by step)
- [feat design-tests](feat-design-tests.md) — Generate tests from existing specs (second step of design workflow)
- [feat design-fail2pass](feat-design-fail2pass.md) — Verify tests only (third step)
- [feat new](feat-new.md) — Create a new change
- [Designers](../designers/README.md)
- [Indexer](../indexer/README.md)
- [Test profiles](../test-profiles.md)
