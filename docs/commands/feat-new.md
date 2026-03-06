# saif feat new

Create scaffolding for a new feature.

Creates an OpenSpec change directory (e.g. `openspec/changes/add-login/`) and optionally writes a `proposal.md` with your description.

Use this as the first step in the feature workflow before running `feat:design`, `feat:run`, etc.

When `-n`/`--name` is omitted, prompts interactively for the feature name and a brief description.

## Usage

```bash
saif feat new [options]
saif feature new [options]
```

## Arguments

| Argument         | Alias | Type    | Description                                                                                     |
| ---------------- | ----- | ------- | ----------------------------------------------------------------------------------------------- |
| `--name`         | `-n`  | string  | Feature name (kebab-case, e.g. add-greeting-cmd). When omitted, prompts interactively.          |
| `--desc`         | `-d`  | string  | Brief description. When omitted, prompts interactively.                                         |
| `--yes`          | `-y`  | boolean | Non-interactive mode. Requires `--name`/`-n`. Skips all prompts; description defaults to empty. |
| `--openspec-dir` | —     | string  | Path to openspec directory (default: `openspec`)                                                |
| `--project-dir`  | —     | string  | Project directory (default: current working directory)                                         |

## Examples

Interactive: prompts for name and description:

```bash
saif feat new
```

With name (still prompts for description):

```bash
saif feat new -n add-login
```

With description (skips description prompt):

```bash
saif feat new -n add-login -d "Add login endpoint"
```

Non-interactive (no prompts at all):

```bash
saif feat new -y -n add-login
saif feat new -y -n add-login -d "Add login endpoint"
```

Custom openspec directory:

```bash
saif feat new -n greet-cmd --openspec-dir ./my-openspec
```

Custom project directory (e.g. when running from a parent monorepo):

```bash
saif feat new -n greet-cmd --project-dir ./packages/my-app
```

## What it does

1. Runs `pnpm openspec new change <name>` to create the change directory.
2. Creates `proposal.md` in the change dir with given name / description

## Next steps

After creating a change, run `pnpm agents feat:design` to generate the spec and black-box test scaffolding, or see [Commands](README.md) for the full workflow.
