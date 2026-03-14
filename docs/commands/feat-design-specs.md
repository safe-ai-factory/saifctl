# saif feat design-specs

Generate specs from a feature's proposal — the first step of `feat design` only.

When `discovery.md` exists in the feature directory (from a prior `saif feat design-discovery` run), the designer receives both `proposal.md` and `discovery.md`.

Runs the designer (e.g. Shotgun) to produce spec files from `proposal.md`. Use this when you want spec generation only, without proceeding to tests generation. The full `feat design` command runs this step first, then continues automatically.

When `--name`/`-n` is omitted, prompts interactively with a list of existing features.

## Usage

```bash
saif feat design-specs [options]
saif feature design-specs [options]
```

## Arguments

| Argument        | Alias | Type    | Description                                                                                                                                                     |
| --------------- | ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`        | `-n`  | string  | Feature name (kebab-case). Prompts with a list if omitted.                                                                                                      |
| `--yes`         | `-y`  | boolean | Non-interactive mode. Requires `--name`. Skips confirm when designer output exists; assumes redo.                                                               |
| `--force`       | `-f`  | boolean | Always re-run the designer, overwriting existing spec files without prompting.                                                                                  |
| `--designer`    | —     | string  | Designer profile for spec generation (default: shotgun)                                                                                                         |
| `--model`       | —     | string  | LLM model. Single global or comma-separated `agent=model`. At most one global. See [models.md](../models.md).                                                   |
| `--base-url`    | —     | string  | LLM base URL. Single global or comma-separated `agent=url` (e.g. `http://localhost:11434/v1` or `pr-summarizer=https://api.openai.com/v1`). At most one global. |
| `--saif-dir`    | —     | string  | Path to saif directory (default: `saif`)                                                                                                                        |
| `--project-dir` | —     | string  | Project directory (default: current working directory)                                                                                                          |

## Examples

Interactive (prompts for feature name):

```bash
saif feat design-specs
```

With name:

```bash
saif feat design-specs -n add-login
```

With a specific designer and model:

```bash
saif feat design-specs --designer shotgun --model anthropic/claude-opus-4-5
```

With per-agent model overrides:

```bash
saif feat design-specs --model tests-planner=anthropic/claude-3-5-sonnet-latest,results-judge=openai/gpt-4o
```

Non-interactive:

```bash
saif feat design-specs -y
```

Force re-run (overwrite existing spec files without prompting):

```bash
saif feat design-specs -f
saif feat design-specs -n add-login --force
```

Custom project directory (e.g. when running from a parent monorepo):

```bash
saif feat design-specs --project-dir ./packages/my-app
```

## Environment variables

| Variable           | Required | Description                                                                                                      |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `SHOTGUN_PYTHON`   | no       | Path to the Python binary that has `shotgun-sh` installed (default: `python`). Example: `$(uv run which python)` |
| `CONTEXT7_API_KEY` | no       | API key for Context7 documentation lookup inside Shotgun. Configured once via `saif init`.                       |

\*At least one LLM API key is required. The key to set depends on which provider you want to use. See [Models](../models.md) for auto-discovery rules.

## What it does

1. Checks if the designer has already run for this feature; prompts to redo if so (skipped with `--yes`).
2. Runs the designer (e.g. Shotgun) to research your codebase and produce enriched spec files in `saif/features/<name>/`.

## Next steps

To continue to test planning and scaffolding, run `saif feat design` (which includes this step), or run `saif feat design-tests` to generate tests from existing specs without re-running spec generation.

## See also

- [LLM configuration](../models.md) — Model flags, agent names, auto-discovery, and tier env vars
- [feat design](feat-design.md) — Full design flow (spec gen + tests planning + Fail2Pass)
- [feat design-discovery](feat-design-discovery.md) — Gather context using MCP/tools (optional step before design-specs)
- [feat design-tests](feat-design-tests.md) — tests planning + test generation only (second step)
- [feat design-fail2pass](feat-design-fail2pass.md) — Test validation only (third step)
- [feat run](feat-run.md) — Implement specs with the agent loop (run after design)
- [feat new](feat-new.md) — Create a new feature
- [Designers](../designers/README.md)
