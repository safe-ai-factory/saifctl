# Agent profiles

## Overview

When you run `pnpm agents feat:run`, the factory:

1. Creates a sandbox (container with a copy of your repo)
2. Runs a **startup script** once (e.g. `pnpm install`)
3. Runs an **agent setup script** once (e.g. `pipx install aider-chat`)
4. Enters the **work loop**: run the agent → check results → retry on fail
5. Extracts the changes on success.

**Agent integrations provide** the scripts in steps 3 and 4:

- `agent-start.sh` - one-time install
- `agent.sh` - actual agent work

You choose which integration to use via `--agent <id>` or `--agent-script <path/to/script.sh>`.

---

## What Integrations Offer

### 1. Agent script (`agent.sh`)

**Contract every integration must honour:**

| Requirement                | Description                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Read task from file        | Task is written to `$FACTORY_TASK_PATH` before each invocation. Use that path, not CLI args.               |
| Work in the workspace      | In Leash mode: `/workspace`. In `--dangerous-debug`: current directory (sandbox `code/`).                  |
| Exit on completion         | Exit 0 when done, non-zero on failure. The gate runs after the agent exits.                                |
| Headless / non-interactive | Agent must run without prompts (e.g. `--yes`, `--headless`, `--always-approve`).                           |
| No auto-commits            | Agent must not commit; the factory extracts the diff via `git diff`. Some agents need `--no-auto-commits`. |

### 2. Agent setup script (`agent-start.sh`)

- Runs once, after the project startup script, before the agent loop.
- Typically installs the agent CLI (pipx, uv, npm, etc.).
- Must be idempotent (skip if already installed).
- Optional: OpenHands and some others have it; agents baked into the image may have an empty script.

### 3. Log format

- **`openhands`**: Factory parses OpenHands JSON event stream for pretty output. Only OpenHands uses this.
- **`raw`**: Stream lines as-is with `[agent]` prefix. All other integrations use this.

## Adding agents integrations

When adding new agent CLI integrations (agent profiles), I used following approach:

### Step 1 - Smart model to fetch info and code

Model: Sonnet 4.6 or better

Prompt:

```txt
Let's add new agent profile: mini-swe-agent - https://github.com/SWE-agent/mini-swe-agent

Do the integration in 5 distinct steps:
1. write the scaffolding, profile.ts, register it in index.ts and types.ts
2. check docs online for installation requiremens and write agent-start.sh
3. check docs online for how to pass text to the CLI and pass the task text to it in yolo / autonomous mode
4. check docs online for all the flags / options the CLI accepts, and configure it.
5. check docs for configuring API keys, model, provider, and base url, and update it
```

**Things to look out for:**

1. Is the task prompt being passed to the CLI?
2. Is `LLM_MODEL` being passed to the CLI?
3. If supported, is `LLM_PROVIDER` or `LLM_BASE_URL` passed on?
4. Are API keys passed on? Either specific like `OPENAI_API_KEY`, or generic `LLM_API_KEY`.
5. Is the CLI configured to run in yolo / autonomous mode?
6. Is the agent's profile registered in `index.ts` and `types.ts`?

### Step 2 - Fast model to update docs

Model: Cursor Composer 1.5

Prompt:

```txt
ok, now check for all the places where we mention all the agentic CLI integrations, and add our new integration there
```

## Agent benchmarks

- https://www.tbench.ai/leaderboard/terminal-bench/2.0
