# Kilo Code CLI

[Kilo Code](https://github.com/Kilo-Org/kilocode) is an OpenCode fork. Installed via npm — requires Node.js 20.18.1+.

**Usage:** `pnpm agents feat:run my-feature --agent kilocode`

## How we call it

```bash
export OPENCODE_CONFIG_CONTENT='{"model":"$LLM_MODEL","permission":"allow","autoupdate":false,...}'
kilo run \
  --auto \
  "$(cat "$FACTORY_TASK_PATH")"
```
Provider config (apiKey, baseURL) is injected via `OPENCODE_CONFIG_CONTENT` as JSON.

## Notes

- **npm install at runtime** — Installed via `npm install -g @kilocode/cli`. Node.js 20.18.1+ required.
- **Model format** — `provider/model` (e.g. `anthropic/claude-sonnet-4-5`).
  - Provider inferred from prefix when `LLM_PROVIDER` is unset.
- **Base URL** — Passed in the injected provider config when `LLM_BASE_URL` is set.
- **Older CPUs** — The npm package may crash with "Illegal instruction" on CPUs without AVX; use the `-baseline` release instead.
