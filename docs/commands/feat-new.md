# saifctl feat new

Create scaffolding for a new feature.

Creates an feature directory (e.g. `saifctl/features/add-login/`) and optionally writes a `proposal.md` with your description.

Use this as the first step in the feature workflow before running [feat design](feat-design.md), [feat run](feat-run.md), etc.

When `-n`/`--name` is omitted, prompts interactively for the feature name and a brief description.

## Usage

```bash
saifctl feat new [options]
saifctl feature new [options]
```

## Arguments

| Argument        | Alias | Type    | Description                                                                                     |
| --------------- | ----- | ------- | ----------------------------------------------------------------------------------------------- |
| `--name`        | `-n`  | string  | Feature name (kebab-case, e.g. add-greeting-cmd). When omitted, prompts interactively.          |
| `--desc`        | —     | string  | Brief description. When omitted, prompts interactively.                                         |
| `--yes`         | `-y`  | boolean | Non-interactive mode. Requires `--name`/`-n`. Skips all prompts; description defaults to empty. |
| `--saifctl-dir`  | —     | string  | Path to saifctl directory (default: `saifctl`)                                                    |
| `--project-dir` | —     | string  | Project directory (default: current directory)                                          |

## Examples

Interactive: prompts for name and description:

```bash
saifctl feat new
```

With name (still prompts for description):

```bash
saifctl feat new -n add-login
```

With description (skips description prompt):

```bash
saifctl feat new --desc "Add login endpoint"
```

Non-interactive (no prompts at all):

```bash
saifctl feat new -y -n add-login
saifctl feat new -y -n add-login --desc "Add login endpoint"
```

Custom saifctl directory:

```bash
saifctl feat new --saifctl-dir ./my-saifctl
```

Custom project directory (e.g. when running from a parent monorepo):

```bash
saifctl feat new --project-dir ./packages/my-app
```

## What it does

1. Creates `proposal.md` in the feature dir with given name / description

## Next steps

After creating a feature, run [feat design](feat-design.md) to generate the specs and tests, then [feat run](feat-run.md) to implement. See [Commands](README.md) for the full workflow.
