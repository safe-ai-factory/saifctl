# Forge Code

[Forge Code](https://forgecode.dev) is a Rust binary that runs fully headlessly. Installed at runtime via a curl script — no Node or Python required.

**Usage:** `saif feat run --agent forge`

## How we call it

```bash
forge config set model "$LLM_MODEL"
forge \
  --agent forge \
  --verbose \
  -p "$(cat "$FACTORY_TASK_PATH")"
```

Forge has no `--model` flag; we set the model via config before running.

## Notes

- **curl required** — Installed via `curl -fsSL https://forgecode.dev/cli | sh`. Minimal deps.
- **API keys** — `FORGE_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`; fallback to `LLM_API_KEY`.
- **Base URL** — `LLM_BASE_URL` forwarded as `OPENAI_URL`. For Anthropic-compatible endpoints, set `ANTHROPIC_URL` directly.
