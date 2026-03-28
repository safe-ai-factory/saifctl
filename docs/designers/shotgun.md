# Shotgun

[Shotgun](https://github.com/shotgun-sh/shotgun) is the default spec designer. It takes your feature proposal, researches your codebase, and produces a full technical spec — `plan.md`, `specification.md`, `research.md`, and `tasks.md` — before any coding agent runs.

**Usage:** `saifctl feat design` (default) or `saifctl feat design --designer shotgun`

> **Note:** Shotgun also serves as a codebase indexer (`--indexer shotgun`). These are two separate roles. This page covers the designer role. See [Shotgun as indexer](../indexer/shotgun.md) for the indexing role.

---

## Setup

Shotgun requires Python 3.11+.

### Install

```bash
pip install shotgun-sh
# or with uv (recommended):
uv add shotgun-sh
```

### Configure

Run the interactive config wizard once to set your LLM provider and API key:

```bash
python -m shotgun.main config init
```

This stores the configuration so you don't need to set environment variables on every run.

---

## Usage

```bash
# Default — Shotgun runs automatically:
saifctl feat design

# Explicit:
saifctl feat design --designer shotgun

# With a specific model:
saifctl feat design --designer shotgun --model claude-opus-4-5

# From a parent monorepo (custom project dir):
saifctl feat design --project-dir ./packages/my-app
```

If the spec files already exist in the feature directory, the CLI asks whether to redo them — safe to re-run at any time.

---

## Environment variables

| Variable                         | Purpose                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                 | API key for OpenAI, OpenRouter, or any OpenAI-compatible provider                                                                            |
| `ANTHROPIC_API_KEY`              | API key for Anthropic (Claude)                                                                                                               |
| `SHOTGUN_OPENAI_COMPAT_BASE_URL` | Base URL for OpenAI-compatible providers (e.g. `https://openrouter.ai/api/v1`). Required when using OpenRouter or other proxies              |
| `CONTEXT7_API_KEY`               | (Optional) Enables documentation lookup during Shotgun's research phase. Free account at [context7.com](https://context7.com)                |
| `SHOTGUN_PYTHON`                 | Path to the Python binary with `shotgun-sh` installed (default: `python`). Set when using uv: `export SHOTGUN_PYTHON=$(uv run which python)` |

Shotgun supports OpenAI, Anthropic, and any OpenAI-compatible provider. [OpenRouter](https://openrouter.ai) is the recommended choice — one API key for virtually any model:

```bash
export SHOTGUN_OPENAI_COMPAT_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_API_KEY=sk-or-...   # your OpenRouter key
```

---

## What it produces

Running `saifctl feat design` with the Shotgun designer writes four files into `saifctl/features/<feature>/`:

| File               | Purpose                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `plan.md`          | Step-by-step implementation roadmap, grounded in your existing codebase patterns |
| `specification.md` | Precise behavior contract the coding agent must satisfy                          |
| `research.md`      | Codebase findings Shotgun used to inform the spec                                |
| `tasks.md`         | Discrete work items broken out from the plan                                     |

These files are consumed downstream by the when planning and writing tests.

---

## How it works

1. **Read the proposal** — Shotgun reads your `saifctl/features/<feature>/proposal.md`. One paragraph is enough; if the file is missing, Shotgun runs a generic research pass.

2. **Research the codebase** — Shotgun's internal research agents query your repo using [tree-sitter](https://tree-sitter.github.io) and (optionally) Context7, finding existing patterns, file structures, and conventions relevant to your feature.

3. **Write the spec** — Based on the research, Shotgun's spec-writing agents produce `plan.md`, `specification.md`, `research.md`, and `tasks.md` — all grounded in your actual code structure.

4. **Hand off** — During tests generationg, we read `specification.md` and `plan.md` to generate deterministic tests. A test-writing agent reads the full spec to implement the feature.

## Notes

- Shotgun manages its own codebase querying internally. When used as a designer, it does not delegate to the factory's `--indexer` tool — it runs its own research pipeline. This is why `saifctl init` (which builds the indexer's graph) is not required before using Shotgun as a designer.

---

## See Also

- [Spec designers](./README.md)
- [Shotgun as indexer](../indexer/shotgun.md)
- [Commands reference](../commands/README.md)
- [Environment variables](../env-vars.md)
