# GitHub Copilot CLI

[GitHub Copilot CLI](https://github.com/github/copilot-cli) routes AI requests through GitHub's API. Requires an active Copilot subscription.

**Usage:** `pnpm agents feat:run my-feature --agent copilot`

## How we call it

```bash
copilot \
  --prompt "$(cat "$FACTORY_TASK_PATH")" \
  --allow-all \
  --no-ask-user \
  --no-auto-update \
  --autopilot
```
`--model "$LLM_MODEL"` is appended only when `LLM_MODEL` is set.

## Notes

- **npm install at runtime** — Installed via `npm install -g @github/copilot` if not present. Node.js required.
- **Auth** — `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`; fallback to `LLM_API_KEY`.
- **No base URL** — Copilot always routes through GitHub's API. Custom endpoints are not supported.
- **Model names** — `LLM_MODEL` must be a GitHub-managed identifier (e.g. `claude-sonnet-4.5`, `gpt-4.1`), not arbitrary provider/model strings.
- **Auto-commits** — Copilot does not expose `--no-auto-commits`. The factory still detects changes via `git log` (checks both diff and recent commits).
