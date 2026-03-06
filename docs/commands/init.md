# saif init

Initialize OpenSpec + Shotgun (requires CONTEXT7_API_KEY).

One-time setup: creates the `openspec/` directory, configures Shotgun with your Context7 API key, and indexes the codebase for spec-driven workflows.

## Requirements

- **CONTEXT7_API_KEY** — Set in your environment before running.
- **LLM API key** — One of: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`

## Usage

```bash
saif init [options]
```

## Arguments

| Argument         | Alias | Type    | Description                                            |
| ---------------- | ----- | ------- | ------------------------------------------------------ |
| `--force`        | `-f`  | boolean | Run `openspec init` even if `openspec/` exists           |
| `--project`      | `-p`  | string  | Project name override (default: `package.json` "name") |
| `--openspec-dir` | —     | string  | Path to openspec directory (default: `openspec`)       |

## Examples

Basic init (uses `package.json` name as project):

```bash
saif init
```

Force re-initialize OpenSpec even if `openspec/` already exists:

```bash
saif init -f
```

Override project name:

```bash
saif init -p my-project
```

Use a custom openspec directory:

```bash
saif init --openspec-dir ./my-openspec
```

## What it does

1. Runs `pnpm openspec init` (skipped if `openspec/` exists, unless `-f`)
2. Runs `uv run shotgun-sh config init`
3. Configures Context7 API key via `shotgun-sh config set-context7`
4. Indexes the codebase with `shotgun-sh codebase index . --name <project>`
