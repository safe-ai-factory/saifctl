# saif feat design-tests

Generate tests from existing specs (second step of design workflow).

Reads the spec files already produced by `feat design-specs` (or `feat design`). First produces a catalog of all tests - `tests.md` and `tests.json`. Then generates test implementation files (e.g. `*.spec.ts`).

Use this when specs are already up to date and you only want to regenerate or update the tests.

## Usage

```bash
saif feat design-tests [options]
saif feature design-tests [options]
```

## Arguments

| Argument           | Alias | Type    | Description                                                                                                                                 |
| ------------------ | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`           | `-n`  | string  | Feature name (kebab-case). Prompts with a list if omitted.                                                                                  |
| `--force`          | `-f`  | boolean | Overwrite existing test scaffold files.                                                                                                     |
| `--skip-catalog`   | —     | boolean | Skip catalog generation and use the existing `tests.json`. Useful when re-generating only the test files.                                   |
| `--model`          | —     | string  | LLM model. Single global or comma-separated `agent=model`. At most one global. See [models.md](../models.md).                                |
| `--base-url`       | —     | string  | LLM base URL. Single global or comma-separated `agent=url` (e.g. `http://localhost:11434/v1` or `pr-summarizer=https://api.openai.com/v1`). At most one global. |
| `--saif-dir`       | —     | string  | Path to saif directory (default: `saif`)                                                                                                    |
| `--project-dir`    | —     | string  | Project directory (default: current working directory)                                                                                      |
| `--test-profile`   | —     | string  | Test profile id (default: node-vitest)                                                                                                      |
| `--indexer`        | —     | string  | Indexer profile for codebase search (default: shotgun). Pass `none` to disable.                                                             |
| `--project`        | `-p`  | string  | Project name override for the indexer (default: package.json "name")                                                                        |

## Examples

Interactive (prompts for feature name):

```bash
saif feat design-tests
```

With name:

```bash
saif feat design-tests -n add-login
```

Disable the indexer:

```bash
saif feat design-tests --indexer none
```

Force overwrite of existing test files (re-generates `tests.json`):

```bash
saif feat design-tests -f
```

Re-generate only test files (reuses existing `tests.json`):

```bash
saif feat design-tests --skip-catalog
```

Force re-generate only test files (reuses existing `tests.json`):

```bash
saif feat design-tests --force --skip-catalog
```

Use a custom project directory (e.g. when running from a parent monorepo):

```bash
saif feat design-tests --project-dir ./packages/my-app
```

Use a specific model for the test generation agents:

```bash
saif feat design-tests --model anthropic/claude-3-5-sonnet-latest
```

Use per-agent overrides (e.g. stronger planner, cheaper coder):

```bash
saif feat design-tests --model tests-planner=anthropic/claude-opus-4-5,tests-catalog=anthropic/claude-3-5-sonnet-latest,tests-writer=openai/gpt-4o-mini
```

## What it does

1. Runs an AI agent to produce a plan of tests to write - `tests.md` (human-readable) and `tests.json` (machine-readable) from your spec files. Skipped when `--skip-catalog` is passed — the existing `tests.json` is used as-is.
2. Generates actual test files (e.g. `*.spec.ts`) from the catalog — skipping files that already exist.
3. Validates the generated files (e.g. TypeScript compile check).

## See also

- [LLM configuration](../models.md) — Model flags, agent names, auto-discovery, and tier env vars
- [feat design](feat-design.md) — Full design flow (spec gen + tests design + tests validation)
- [feat design-specs](feat-design-specs.md) — Spec gen only (first step)
- [feat design-fail2pass](feat-design-fail2pass.md) — Tests validation only (third step)
- [feat run](feat-run.md) — Implement specs with the agent loop (run after design)
- [feat new](feat-new.md) — Create a new feature
- [Test profiles](../test-profiles.md)
- [Indexer](../indexer/README.md)
