# Agent profiles

## Overview

When you run `saifctl feat run`, the factory:

1. Creates a sandbox (container with a copy of your repo)
2. Runs a **startup script** once (e.g. `pnpm install`)
3. Runs an **agent setup script** once (e.g. `pipx install aider-chat`)
4. Enters the **work loop**: run the agent → check results → retry on fail
5. Extracts the changes on success.

**Agent integrations provide** the scripts in steps 3 and 4:

- `agent-install.sh` - one-time install
- `agent.sh` - actual agent work

You choose which integration to use via `--agent <id>` or `--agent-script <path/to/script.sh>`.

---

## What Integrations Offer

### 1. Agent script (`agent.sh`)

**Contract every integration must honour:**

| Requirement                | Description                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Read task from file        | Task is written to `$SAIFCTL_TASK_PATH` before each invocation. Use that path, not CLI args.               |
| Work in the workspace      | In Leash mode: `/workspace`. With `--engine local`: current directory (sandbox `code/`). |
| Exit on completion         | Exit 0 when done, non-zero on failure. The gate runs after the agent exits.                                |
| Headless / non-interactive | Agent must run without prompts (e.g. `--yes`, `--headless`, `--always-approve`).                           |
| No auto-commits            | Agent must not commit; the factory extracts the diff via `git diff`. Some agents need `--no-auto-commits`. |

### 2. Agent install script (`agent-install.sh`)

- Runs once, after the project startup script, before the agent loop.
- Typically installs the agent CLI (pipx, uv, npm, etc.).
- Must be idempotent (skip if already installed).
- Optional: OpenHands and some others have it; agents baked into the image may have an empty script.

### 3. Agent logging

Some agents emit logs in formats which are not easy to read for human. For example OpenHands prints structured JSON events, whereas Aider emits a line-wise output.

Thus we need to 1) handle logs per-agent, and 2) have ability to transform the agent's logs into human-friendly format. This is defined on every **agent profile** as a required **`stdoutStrategy`** field: either a strategy object or **`null`**.

For example, OpenHands sets a strategy that detects the start and end of its JSON events. JSON events are then turned e.g. into `[think]`, etc, segments, while the rest is logged as-is.

Profiles with **`stdoutStrategy: null`** get line-wise `[agent]`-prefixed output inside the `[SAIFCTL:AGENT_*]` window.

This is not configurable via CLI or `saifctl.config`.

## Adding agents integrations

When adding new agent CLI integrations (agent profiles), I used following approach:

### Step 1 - Smart model to fetch info and code

Model: Sonnet 4.6 or better

Prompt:

```txt
Let's add new agent profile: mini-swe-agent - https://github.com/SWE-agent/mini-swe-agent

Do the integration in 5 distinct steps:
1. write the scaffolding, profile.ts, register it in index.ts and types.ts
2. check docs online for installation requiremens and write agent-install.sh
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
