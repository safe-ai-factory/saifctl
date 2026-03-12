# Software Factory: Using a Custom Coding Agent

This document describes how to use a coding agent other than OpenHands with the Software Factory. The default agent is OpenHands; you can substitute Aider, Claude Code, Codex, Deep Agents, or any CLI that edits files and reads from the workspace.

---

## Overview

The factory loop runs a **user-supplied agent script** once per inner round. That script:

1. **Reads the task** from the environment variable `$FACTORY_TASK_PATH` (a markdown file)
2. **Invokes your preferred agent** (Aider, Claude Code, etc.) with the task
3. **Exits** when the agent completes

The task file is written by `coder-start.sh` before each invocation, so you don't pass the task via CLI arguments — avoiding escaping issues and argument length limits.

---

## Step 1: Write an Agent Runner Script

Create a bash script that runs your agent. The script **must** read the task from `$FACTORY_TASK_PATH`.

### Example: Aider

```bash
#!/bin/bash
# aider-runner.sh — run Aider with the task from $FACTORY_TASK_PATH
set -euo pipefail

aider --message-file "$FACTORY_TASK_PATH" --yes
```

### Example: Claude Code

```bash
#!/bin/bash
# claude-runner.sh — run Claude Code with the task from $FACTORY_TASK_PATH
set -euo pipefail

claude --print "$(cat "$FACTORY_TASK_PATH")"
```

### Example: Custom Python Script

```bash
#!/bin/bash
# my-agent-runner.sh
set -euo pipefail

python ./scripts/my-agent.py --task-file "$FACTORY_TASK_PATH"
```

### Contract Your Script Must Honour

| Requirement                         | Description                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read task from `$FACTORY_TASK_PATH` | The factory writes the full task (plan + optional error feedback) to this file before each invocation. Do **not** pass the task via `-t "..."` or similar — use the file path. |
| Work in the workspace               | In Leash mode the workspace is `/workspace`. In `--dangerous-debug` mode it is the current working directory (sandbox `code/`). Your agent must edit files in that directory.  |
| Exit on completion                  | Exit code 0 when done, non-zero on failure. The factory uses the exit code to decide whether to run the gate.                                                                  |
| Use env vars for config             | Your agent can read `LLM_MODEL`, `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, and any extra vars you pass via `--agent-env` or `--agent-env-file`.                           |

---

## Step 2: Make the Script Executable

```bash
chmod +x ./aider-runner.sh
```

---

## Step 3: Ensure Your Agent Is Available in the Container

### Option A: Use the Default Coder Image (OpenHands pre-installed)

If your agent is a **npm package** (e.g. `aider`), you can install it in the startup script:

```bash
#!/bin/bash
# startup-with-aider.sh
set -euo pipefail
cd /workspace
npm install
npm install -g aider
```

Then run:

```bash
saif feat run \
  --agent-script ./aider-runner.sh \
  --startup-script ./startup-with-aider.sh
```

### Option B: Extend the Coder Base Image

For agents that need custom binaries or heavy dependencies, extend `Dockerfile.coder-base` and build your own image:

```dockerfile
# Dockerfile.my-coder
FROM factory-coder-base:latest

# Install Aider (Python)
RUN pip install aider-chat

# Or install a Rust binary
# RUN cargo install my-agent-cli
```

Build and tag:

```bash
docker build -f Dockerfile.my-coder -t my-coder:latest .
```

Then run with `--coder-image my-coder:latest`:

```bash
saif feat run \
  --agent-script ./aider-runner.sh \
  --coder-image my-coder:latest
```

---

## Step 4: Pass Extra Environment Variables (Optional)

### Automatically forwarded

The factory **always** forwards these variables into the agent container (Leash mode) or process (dangerous-debug mode):

| Variable             | Source                                                                | Purpose                                                                                                                          |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_MODEL`          | `--model` flag, then `LLM_MODEL` env                                  | Model identifier (e.g. `gpt-4o`, `anthropic/claude-sonnet-4-6`)                                                                  |
| `LLM_PROVIDER`       | `--provider` flag, then `LLM_PROVIDER` env                            | Provider ID for base URL / routing (e.g. anthropic, openrouter). Used by opencode when `LLM_MODEL` is not provider/model format. |
| `LLM_API_KEY`        | Resolved from `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` (first set wins) | Primary API key for LLM calls                                                                                                    |
| `LLM_BASE_URL`       | `--base-url` flag, then `LLM_BASE_URL` env                            | Base URL for the LLM API endpoint (e.g. OpenRouter, custom proxy)                                                                |
| `ANTHROPIC_API_KEY`  | Host `process.env`                                                    | Forwarded if set (for Anthropic models)                                                                                          |
| `OPENAI_API_KEY`     | Host `process.env`                                                    | Forwarded if set (for OpenAI / OpenRouter models)                                                                                |
| `OPENROUTER_API_KEY` | Host `process.env`                                                    | Forwarded if set (for OpenRouter)                                                                                                |
| `GEMINI_API_KEY`     | Host `process.env`                                                    | Forwarded if set (for Google models)                                                                                             |

In **dangerous-debug mode**, the agent inherits the full host environment (including all of the above), so no extra setup is needed for standard API keys.

### Single variables (custom)

```bash
saif feat run \
  --agent-script ./aider-runner.sh \
  --agent-env AIDER_MODEL=gpt-4o \
  --agent-env AIDER_YES=1
```

### Agent env file (recommended for many vars)

Create `agent.env`:

```bash
# agent.env
AIDER_MODEL=gpt-4o
AIDER_YES=1
# Optional: model-specific keys
# OPENAI_API_KEY=sk-...
```

Run:

```bash
saif feat run \
  --agent-script ./aider-runner.sh \
  --agent-env-file ./agent.env
```

**Reserved variables**: The factory filters out `FACTORY_*`, `WORKSPACE_BASE`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_PROVIDER`, and `LLM_BASE_URL`. If you pass them via `--agent-env`, they are ignored with a warning.

---

## Step 5: Set the Agent Log Format

Non-OpenHands agents usually don't emit the `--json` event stream. Use `--agent-log-format raw` so stdout is streamed line-by-line instead of parsed as JSON:

```bash
saif feat run \
  --agent-script ./aider-runner.sh \
  --agent-log-format raw
```

| Value                 | Behaviour                                                               |
| --------------------- | ----------------------------------------------------------------------- |
| `openhands` (default) | Parse OpenHands `--json` events; pretty-print actions, thoughts, errors |
| `raw`                 | Stream each line with an `[agent]` prefix; suitable for any agent       |

---

## Step 6: Run the Factory Loop

Invoke `saif feat run` (or `saif run resume <runId>` for resume) with all flags combined:

```bash
saif feat run \
  --agent-script ./aider-runner.sh \
  --agent-log-format raw \
  --agent-env-file ./agent.env \
  --startup-script ./startup-with-aider.sh
```

For `saif run resume`, the same flags apply — you can change the agent script between runs.

---

## Full Example: Aider from Scratch

1. **Create the agent runner** (`aider-runner.sh`):

   ```bash
   #!/bin/bash
   set -euo pipefail
   aider --message-file "$FACTORY_TASK_PATH" --yes
   ```

2. **Create a startup script** that installs Aider (`startup-with-aider.sh`):

   ```bash
   #!/bin/bash
   set -euo pipefail
   cd /workspace
   npm install
   pip install aider-chat
   ```

3. **Ensure API keys are set** (Aider typically uses `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`):

   ```bash
   export OPENAI_API_KEY=sk-...
   # or
   export ANTHROPIC_API_KEY=sk-...
   ```

4. **Run the factory**:

   ```bash
   chmod +x ./aider-runner.sh ./startup-with-aider.sh

   saif feat run \
     --agent-script ./aider-runner.sh \
     --startup-script ./startup-with-aider.sh \
     --agent-log-format raw
   ```

---

## Dangerous-Debug Mode (Host Execution)

If you use `--dangerous-debug`, the agent runs directly on the host (no Docker/Leash). Useful for debugging:

```bash
saif feat run \
  --agent-script ./aider-runner.sh \
  --agent-log-format raw \
  --dangerous-debug
```

In this mode:

- The workspace is the sandbox `code/` directory (path passed as `WORKSPACE_BASE`)
- `$FACTORY_TASK_PATH` points to `{sandbox}/code/.factory_task.md`
- Your agent must be installed on the host

---

## Troubleshooting

| Issue                        | Cause                                                            | Fix                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `agent script not found`     | The path to `--agent-script` is wrong or the file isn't readable | Use an absolute path or a path relative to the repo root; ensure the file exists                                          |
| Agent receives empty task    | `$FACTORY_TASK_PATH` is unset or wrong                           | Don't override `FACTORY_TASK_PATH` via `--agent-env`; the factory sets it automatically                                   |
| `--agent-env` var is ignored | Variable is reserved                                             | Don't pass `FACTORY_*`, `WORKSPACE_BASE`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_PROVIDER`, or `LLM_BASE_URL` via `--agent-env` |
| Agent not found in container | Agent isn't installed in the coder image or startup script       | Install in `--startup-script` or build a custom `--coder-image`                                                           |
| Garbled or missing output    | Using default `openhands` log format with a non-OpenHands agent  | Add `--agent-log-format raw`                                                                                              |

---

## Related Documentation

- [swf-inner-loop.md](./swf-inner-loop.md) — How the inner loop (agent → gate → feedback) works
- [swf-comp-c-openhands.md](./swf-comp-c-openhands.md) — Default OpenHands integration
- [swf-comp-d-leash.md](./swf-comp-d-leash.md) — Leash container security
