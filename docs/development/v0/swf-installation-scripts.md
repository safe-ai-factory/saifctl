# Software Factory Installation Scripts

This document describes the lifecycle scripts and Docker image layering used by the Software Factory. It explains the reasoning behind the design and provides step-by-step examples for custom setups.

## Overview

The Software Factory runs an agent (typically OpenHands) inside a monitored container. The agent works in `/workspace`, which is a bind-mounted copy of the user's repository. Two concerns must be addressed:

1. **Workspace setup** — dependencies must be installed _after_ the workspace is mounted, because `package.json` / `requirements.txt` / `Cargo.toml` live in the workspace. The container image cannot know them at build time.
2. **Early validation** — deterministic checks (lint, typecheck, public tests) should run quickly inside the container to avoid expensive outer-tests cycles for trivial failures.

We address these with two pluggable lifecycle hooks and a layered Docker image design.

---

## Lifecycle Hooks

### 1. Startup script (`/saifctl/startup.sh`)

**Runs:** Once, before the agent loop begins.

**Purpose:** Workspace setup that requires the workspace to be mounted. Examples: `npm ci`, `pip install -r requirements.txt`, `cargo fetch`, `poetry install`.

**Why it must run at runtime:** The workspace is bind-mounted per invocation. The image is built once; each run gets a fresh copy of the repo. Dependencies depend on `package.json` (or equivalent), which is in the workspace. Therefore installation cannot happen at image build time — it must happen after the mount.

**Set via:** `--profile` (default: node-pnpm-python) or `--startup-script`. The profile supplies the installation script (e.g. `pnpm install` for node-pnpm-python).

**Failure mode:** If the startup script fails (exit non-zero), the container exits immediately. No agent rounds are run.

### 2. Gate script (`/saifctl/gate.sh`)

**Runs:** After each agent invocation, up to `SAIFCTL_GATE_RETRIES` times per outer attempt.

**Purpose:** Quick validation to short-circuit the outer tests. Examples: `npm run check`, `pnpm check`, `pytest tests/unit/`, `cargo clippy`.

**Why it matters:** Without the gate, every agent attempt would trigger a full Docker build + test runner run. Deterministic failures (lint, typecheck, failing public tests) are caught cheaply inside the container; the agent gets the output as feedback and can retry before the expensive outer loop.

---

## Docker image layering (coder)

- **Orchestration (`/saifctl`)** — `coder-start.sh`, `gate.sh`, `startup.sh`, agent scripts, and optionally `reviewer.sh` are **copied into** `sandboxBasePath/saifctl/` on the host and bind-mounted as a **single read-only directory** at `/saifctl` inside the Leash container. No separate `coder-base` image is required.
- **`Dockerfile.coder` (per sandbox profile)** — each file chooses its own upstream base (`node:*-bookworm-slim`, `python:*-slim-bookworm`, `golang:*-bookworm`, `rust:*-slim-bookworm`, `continuumio/miniconda3`, etc.) and adds the language runtime + package manager for that profile. Each profile lives under `src/sandbox-profiles/<profile>/`.
- Pre-built images are on GHCR (e.g. `saifctl-coder-node-pnpm-python:latest`); Docker pulls automatically when not present locally.
- **Custom agents:** `FROM` a published `saifctl-coder-*` image or the same upstream base as a profile, install your tooling, then pass `--coder-image`. Use `--startup-script` for per-repo workspace setup without forking the image.

---

## Environment Variables

| Variable                 | Required | Default               | Description                                  |
| ------------------------ | -------- | --------------------- | -------------------------------------------- |
| `SAIFCTL_INITIAL_TASK`   | yes      | —                     | Full task prompt for the agent               |
| `SAIFCTL_GATE_RETRIES`   | no       | 5                     | Max inner gate-retry rounds before giving up |
| `SAIFCTL_GATE_SCRIPT`    | no       | `/saifctl/gate.sh`    | Path to the gate script                      |
| `SAIFCTL_STARTUP_SCRIPT` | yes      | `/saifctl/startup.sh` | Path to the startup script. Must exist.      |

`SAIFCTL_STARTUP_SCRIPT` is always set by the orchestrator. It points to `/saifctl/startup.sh`, which the orchestrator writes from the profile's installation script (or from `--startup-script` when provided). `coder-start.sh` will error if the file is missing.

---

## Sandbox Layout

After sandbox creation (`createSandbox`):

```
/tmp/saifctl/sandboxes/{proj}-{feat}-{runId}/
  gate.sh       ← always written; copied into saifctl/ for the coder container mount
  startup.sh    ← always written from profile or --startup-script; copied into saifctl/
  saifctl/       ← assembled per run (copies of coder-start.sh, gate, startup, agent scripts, reviewer when enabled); mounted :ro at /saifctl
  tests.full.json
  code/         ← rsync copy of repo; mounted as /workspace
```

---

## Design Reasoning

### Why workspace setup must run at runtime

The workspace is rsync’d into `code/` and bind-mounted at `/workspace` for each run. The container image does not contain the user’s `package.json`, lockfile, or source. Running `npm ci` at image build time would install nothing useful — the workspace is empty then.

### Why prefer `--startup-script` over extending the image for `npm ci`

- **Per-repo:** Different projects use different package managers and lockfiles.
- **Per-run:** The workspace is fresh each invocation; installing from the mounted copy keeps dependencies in sync with the code.
- **Simpler:** No custom Dockerfile required for most Node.js projects.

### When to extend the image instead

- Installing a different coder agent (e.g. claude-code instead of OpenHands).
- Adding system deps or runtimes (Python, Rust, etc.) that the base doesn’t have.
- Caching heavy, project-agnostic setup if you control the image and the workspace layout.

---

## Step-by-Step: Node.js (default — no configuration needed)

**The default profile (node-pnpm-python) supplies an installation script that runs `pnpm install`.** For most Node.js/pnpm projects, no configuration is needed:

```bash
saifctl feat run
```

You should see in the logs:

```
  Startup script: built-in (from profile)
...
[coder-start] Running startup script: /path/to/sandbox/startup.sh
[coder-start] Startup script completed.
[coder-start] ===== Round 1/5 =====
```

**To use `pnpm` or `npm ci` instead**, provide a custom startup script:

### Step 1: Create the startup script

Create `scripts/my-startup.sh` in your repo:

```bash
#!/bin/bash
set -euo pipefail
cd /workspace
pnpm install   # or: npm ci
```

Make it executable:

```bash
chmod +x scripts/my-startup.sh
```

### Step 2: Run with `--startup-script`

```bash
saifctl feat run --startup-script ./scripts/my-startup.sh
```

For a resume (continue):

```bash
saifctl run start <runId> --startup-script ./scripts/my-startup.sh
```

---

## Step-by-Step: Custom Setup for Python (pip install)

**Problem:** Your project uses Python and the gate runs `pytest`. Dependencies are in `requirements.txt` and must be installed into the workspace.

### Step 1: Create the startup script

Create `scripts/my-startup.sh`:

```bash
#!/bin/bash
set -euo pipefail
cd /workspace
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Step 2: Create a custom gate (if needed)

The default gate runs `npm run check`. For Python, create `scripts/factory-gate.sh`:

```bash
#!/bin/bash
set -euo pipefail
cd /workspace
source .venv/bin/activate
pytest tests/
```

### Step 3: Run with both scripts

```bash
saifctl feat run \
  --startup-script ./scripts/my-startup.sh \
  --gate-script ./scripts/factory-gate.sh
```

---

## Step-by-Step: Custom Coder Agent

**Problem:** You want to use claude-code or another coder instead of OpenHands.

### Step 1: Create your custom Dockerfile

Create `Dockerfile.my-coder` in your repo:

```dockerfile
FROM node:25-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl python3 python3-venv python3-pip pipx \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm @anthropic-ai/claude-code
# or: RUN uv tool install openhands (with uv on PATH)
# or: whatever your coder requires
```

(The default coder image is pulled from GHCR when omitted — build a custom image only when you need extra system packages or a different agent stack.)

### Step 2: Build and use

```bash
docker build -f Dockerfile.my-coder -t my-saifctl-coder:latest .
saifctl feat run --coder-image my-saifctl-coder:latest
```

**Note:** `coder-start.sh` runs `/saifctl/agent.sh` each round; the default agent profile’s `agent.sh` invokes the AI agent (e.g. OpenHands). Use `--agent` / `--agent-script` to swap the coding CLI without forking `coder-start.sh`.

---

## Step-by-Step: Full Custom (Python project + custom gate)

Combining startup script, custom gate, and optional custom image.

### 1. Startup script: `scripts/my-startup.sh`

```bash
#!/bin/bash
set -euo pipefail
cd /workspace
uv sync   # or: pip install -r requirements.txt
```

### 2. Gate script: `scripts/factory-gate.sh`

```bash
#!/bin/bash
set -euo pipefail
cd /workspace
source .venv/bin/activate
uv run pytest tests/unit/ --tb=short
uv run ruff check .
```

### 3. Run

```bash
saifctl feat run \
  --startup-script ./scripts/my-startup.sh \
  --gate-script ./scripts/factory-gate.sh
```

---

## CLI Reference

| Flag               | Subcommands                        | Description                                                                                                                                                                              |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--model`          | saifctl feat run, saifctl run start | LLM model override (e.g. anthropic/claude-sonnet-4-5). Falls back to `LLM_MODEL` env.                                                                                                    |
| `--provider`       | saifctl feat run, saifctl run start | LLM provider ID (e.g. anthropic, openai, openrouter). Forwarded as `LLM_PROVIDER`. Used by agents like opencode for base URL / routing when `LLM_MODEL` is not in provider/model format. |
| `--base-url`       | saifctl feat run, saifctl run start | LLM base URL override (e.g. https://openrouter.ai/api/v1). Falls back to `LLM_BASE_URL` env.                                                                                             |
| `--profile`        | saifctl feat run, saifctl run start | Sandbox profile; sets the installation script (and other defaults).                                                                                                                      |
| `--startup-script` | saifctl feat run, saifctl run start | Path to script run once before the agent loop (overrides profile).                                                                                                                       |
| `--gate-script`    | saifctl feat run, saifctl run start | Path to script run after each agent round. Default: built-in pnpm check.                                                                                                                 |
| `--gate-retries`   | saifctl feat run, saifctl run start | Max gate retries per run (default: 5).                                                                                                                                                   |
| `--coder-image`    | saifctl feat run, saifctl run start | Docker image for the coder container (default: from profile, e.g. saifctl-coder-node-pnpm-python:latest).                                                                                |

---

## Security

- **Startup and gate scripts** are mounted `:ro` — the agent cannot modify them.
- **`coder-start.sh`** is baked into the image — not injected per-run; the agent cannot reach it.
- Scripts run inside the container with access to `/workspace` only; no additional host trust surface.
