# OpenHands

[OpenHands](https://github.com/OpenHands/OpenHands) is the default coding agent. Uses the same env var names as the factory — no mapping needed.

**Usage:** `pnpm agents feat:run my-feature` (default) or `--agent openhands`

## How we call it

```bash
openhands --headless --always-approve --override-with-envs --json -t "$(cat "$FACTORY_TASK_PATH")"
```

## Notes

- **Python required** — Installed via uv (preferred), pipx, or pip. Node-only images will fail.
- **Env vars** — Uses `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` directly. `--override-with-envs` applies them over stored settings.
- **Log format** — Emits JSONL; the factory parses it for pretty output (unlike other agents, which use raw line streaming).
