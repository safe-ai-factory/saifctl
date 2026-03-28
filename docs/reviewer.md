# Semantic Code Reviewer

After your agent finishes coding and passes standard static checks (`gate` script), an AI reviewer checks the diff to ensure the original goal was actually met.

If the agent missed logic, hallucinated APIs, or failed to complete the task, the reviewer catches it, fails the gate, and sends feedback back to the agent for another try.

---

## When it runs

The reviewer runs inside the container loop right before finishing an attempt.

```
Agent writes code
       ↓
Gate script — static checks (e.g. lint, format)
       ↓ pass
AI reviewer — semantic review
       ↓ pass
Round complete → exit container
```

The reviewer runs only for:

- `saifctl feat run`
- `saifctl run start`

To disable the reviewer, you can, pass `--no-reviewer`.

---

## Configure the reviewer

The reviewer is **enabled by default**.

You can configure the reviewer to use a different model than the main coding agent. A common pattern is using a fast/cheap model for coding, but a powerful reasoning model for review.

### Using CLI flags

```bash
# Use Sonnet for the coder, and Opus for the reviewer
saifctl feat run --model coder=anthropic/claude-sonnet-4-6,reviewer=anthropic/claude-opus-4-6

# Disable the reviewer for this run
saifctl feat run --no-reviewer
```

### Using config file

To configure this permanently, update `saifctl/config.json`:

```json
{
  "defaults": {
    "agentModels": {
      "coder": "anthropic/claude-sonnet-4-6",
      "reviewer": "openai/gpt-4o"
    }
  }
}
```

---

## How it works

The reviewer workflow is implemented by the [`argus-ai`](https://github.com/Meru143/argus) project.

Argus provides best practices for semantic code review:

- Reviews are checked for false positives.
- Reviewer can search the codebase to understand call stacks across files.
- Reviewer compares the diff against the original task.

The factory downloads the Argus Linux binary for the current architecture on first use and caches it under `/tmp/saifctl/bin/`. The binary is mounted into the container alongside a script (`reviewer.sh`). The script writes Argus TOML to **`.saifctl/argus.toml`** and runs `argus --config` so the repo root stays free of `.argus.toml`. See `vendor/README.md`.

If Argus spots an issue, it prints findings like `- file.ts:42: Missing error handling` which the factory feeds back into the prompt for the next agent iteration.

## Troubleshooting

- **Argus binary download failed**  
  SAIF auto-downloads the binary on first use. If the download fails, check `https://github.com/JuroOravec/argus/releases` for the expected tag and assets. Clear `/tmp/saifctl/bin/argus-linux-*` (or your `SAIF_REVIEWER_BIN_DIR`) and retry. Use `--no-reviewer` to bypass.
- **Reviewer passes but tests fail**  
  The reviewer verifies _intent and logic_ from the git diff. It does not actually execute your code or tests. Tests verification runs in the next stage after the reviewer passes.

## See Also

- [Environment variables](env-vars.md) — `SAIF_REVIEWER_BIN_DIR`, `REVIEWER_LLM_*`, and container vars
- [Models](models.md) — Agent reference and `--model` usage
- [Meru143/argus](https://github.com/Meru143/argus) — Argus semantic review tool
