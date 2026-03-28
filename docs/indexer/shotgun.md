# Shotgun

[Shotgun](https://github.com/shotgun-sh/shotgun) is the default codebase indexer. It parses your repository into a semantic graph so the factory's agents can ask questions like "where is auth handled?" or "what ORM does this project use?" — and get back real file paths and code references instead of guesses.

**Usage:** `saifctl init` (default) or `saifctl init --indexer shotgun`

NOTE: Shotgun serves a dual role, but as indexer and designer. [See here how to use Shotgun as designer](../designer/shotgun.md).

---

## Setup

Shotgun requires Python 3.11+.

### Install

```bash
pip install shotgun-sh
# or with uv:
uv sync
```

### Index your codebase

The index is built automatically when you run `saifctl init`:

```bash
saifctl init
```

This runs the full Shotgun setup: config wizard → (optional) Context7 integration → codebase indexing. Takes ~5 minutes on first run.

### Re-indexing

Re-run `saifctl init` whenever your codebase changes significantly. The graph ID is resolved automatically by project name — you don't need to track it.

---

## Environment variables

| Variable                         | Purpose                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                 | API key for OpenAI, OpenRouter, or any OpenAI-compatible provider                                                                                     |
| `ANTHROPIC_API_KEY`              | API key for Anthropic (Claude)                                                                                                                        |
| `SHOTGUN_OPENAI_COMPAT_BASE_URL` | Base URL for OpenAI-compatible providers (e.g. `https://openrouter.ai/api/v1`). Required when using OpenRouter or other proxies                       |
| `CONTEXT7_API_KEY`               | (Optional) Enables documentation lookup during Shotgun's research phase. Free account at [context7.com](https://context7.com)                         |
| `SHOTGUN_PYTHON`                 | Path to the Python binary that has `shotgun-sh` installed (default: `python`). Set this when using uv: `export SHOTGUN_PYTHON=$(uv run which python)` |

Shotgun supports OpenAI, Anthropic, and **any OpenAI-compatible provider** (OpenRouter, Azure OpenAI, Groq, Together AI, local proxies, etc.). OpenRouter is the recommended choice — it gives you access to virtually any model (Gemini, Mistral, Meta Llama, and more) under a single API key:

```bash
export SHOTGUN_OPENAI_COMPAT_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_API_KEY=sk-or-...   # your OpenRouter key
```

The easiest way to configure this is via the interactive `config init` wizard — it prompts you for the provider and key, and stores them so you don't need to set env vars on every run.

---

## Manual CLI usage

You can also run Shotgun directly, outside of the factory workflow:

```bash
# Run the config wizard once
python -m shotgun.main config init

# Index your codebase
python -m shotgun.main codebase index . --name my-project

# List indexed codebases
python -m shotgun.main codebase list

# Query the index directly
python -m shotgun.main codebase query <graphId> "where is auth handled?"
```

This is useful for debugging what the index knows, or for integrating Shotgun into other tooling.

---

## Python environment (`SHOTGUN_PYTHON`)

Shotgun's CLI runs as a Python module (`python -m shotgun.main`). By default it uses whatever `python` resolves to on your `PATH`. If you installed Shotgun into an isolated environment (uv, virtualenv, conda), you need to point `SHOTGUN_PYTHON` at the right binary — otherwise the `shotgun` module won't be found.

**uv (recommended):**

```bash
export SHOTGUN_PYTHON=$(uv run which python)
```

**virtualenv / conda:**

```bash
source .venv/bin/activate          # or: conda activate myenv
export SHOTGUN_PYTHON=$(which python)
```

The factory reads `SHOTGUN_PYTHON` and substitutes it wherever it would otherwise call `python`. You can set it permanently in your `.env` or shell profile so you don't have to repeat it every session.

---

## How Shotgun works

1. **Index** — During `saifctl init`, Shotgun uses [tree-sitter](https://tree-sitter.github.io) to parse your repository into an AST-aware codebase graph. It understands structure: classes, interfaces, function exports, imports, and dependency chains.

2. **Query** — During `saifctl feat design`, the factory's agents call the index with natural-language questions. The graph returns specific code chunks, file paths, and relationships.

3. **Ground the spec** — The Architect Agent uses those answers to write a `spec.md` and `plan.md` constrained strictly to your existing patterns. No invented imports, no phantom file paths.

4. **Hand off** — The Tests planning Agent reads the same grounded plan to write deterministic tests that map to what the agent will actually implement.

---

## See Also

- [Codebase indexers](./README.md)
- [Commands reference](../commands/README.md)
- [Environment variables](../env-vars.md)
