# Software Factory Installation Scripts

This document describes the lifecycle scripts and Docker image layering used by the Software Factory. It explains the reasoning behind the design and provides step-by-step examples for custom setups.

## Overview

The Software Factory runs an agent (typically OpenHands) inside a monitored container. The agent works in `/workspace`, which is a bind-mounted copy of the user's repository. Two concerns must be addressed:

1. **Workspace setup** — dependencies must be installed _after_ the workspace is mounted, because `package.json` / `requirements.txt` / `Cargo.toml` live in the workspace. The container image cannot know them at build time.
2. **Early validation** — deterministic checks (lint, typecheck, public tests) should run quickly inside the container to avoid expensive outer-tests cycles for trivial failures.

We address these with two pluggable lifecycle hooks and a layered Docker image design.

---

## Lifecycle Hooks

### 1. Startup script (`/saifac/startup.sh`)

**Runs:** Once, before the agent loop begins.

**Purpose:** Workspace setup that requires the workspace to be mounted. Examples: `npm ci`, `pip install -r requirements.txt`, `cargo fetch`, `poetry install`.

**Why it must run at runtime:** The workspace is bind-mounted per invocation. The image is built once; each run gets a fresh copy of the repo. Dependencies depend on `package.json` (or equivalent), which is in the workspace. Therefore installation cannot happen at image build time — it must happen after the mount.

**Set via:** `--profile` (default: node-pnpm-python) or `--startup-script`. The profile supplies the installation script (e.g. `pnpm install` for node-pnpm-python).

**Failure mode:** If the startup script fails (exit non-zero), the container exits immediately. No agent rounds are run.

### 2. Gate script (`/saifac/gate.sh`)

**Runs:** After each agent invocation, up to `SAIFAC_GATE_RETRIES` times per outer attempt.

**Purpose:** Quick validation to short-circuit the outer tests. Examples: `npm run check`, `pnpm check`, `pytest tests/unit/`, `cargo clippy`.

**Why it matters:** Without the gate, every agent attempt would trigger a full Docker build + test runner run. Deterministic failures (lint, typecheck, failing public tests) are caught cheaply inside the container; the agent gets the output as feedback and can retry before the expensive outer loop.

---

## Docker Image Layering

We separate concerns into two images:

| Image                | Contents                                      | Built by                  |
| -------------------- | --------------------------------------------- | ------------------------- |
| `saifac-coder-base` | Framework only: `coder-start.sh`, `/saifac/` | `docker build coder-base` |
| `saifac-coder`      | Extends base; adds OpenHands                  | `docker build coder`      |

### `Dockerfile.coder-base`

- **Framework layer** — orchestration logic we always want.
- Contains only `src/orchestrator/scripts/coder-start.sh` at `/saifac/coder-start.sh`.
- No coder agent, no language-specific tooling.
- Extend this when you want a different coder (claude-code, codex, custom).

### `Dockerfile.coder` (per sandbox profile)

- **Default coder layer** — extends `coder-base`, adds runtime + package manager (e.g. Node + pnpm).
- Each sandbox profile (e.g. `node-pnpm-python`) has its own `Dockerfile.coder` in `src/sandbox-profiles/<profile>/`.
- Pre-built images are on GHCR (e.g. `saifac-coder-node-pnpm-python:latest`); Docker pulls automatically when not present locally.
- Extend `coder-base` (or use `--startup-script`) when you need workspace setup or a different coder agent.

### Why separate base and coder?

- **Separation of concerns:** Framework logic (our loop, hooks) vs. coder agent (user’s choice) vs. workspace setup (per-repo).
- **Extensibility:** Users can `FROM saifac-coder-base` and install their own coder without forking our Python/OpenHands setup.
- **Clarity:** The base image is minimal and stable; the coder image is where language/ecosystem choices live.

---

## Environment Variables

| Variable                 | Required | Default               | Description                                  |
| ------------------------ | -------- | --------------------- | -------------------------------------------- |
| `SAIFAC_INITIAL_TASK`   | yes      | —                     | Full task prompt for the agent               |
| `SAIFAC_GATE_RETRIES`   | no       | 5                     | Max inner gate-retry rounds before giving up |
| `SAIFAC_GATE_SCRIPT`    | no       | `/saifac/gate.sh`    | Path to the gate script                      |
| `SAIFAC_STARTUP_SCRIPT` | yes      | `/saifac/startup.sh` | Path to the startup script. Must exist.      |

`SAIFAC_STARTUP_SCRIPT` is always set by the orchestrator. It points to `/saifac/startup.sh`, which the orchestrator writes from the profile's installation script (or from `--startup-script` when provided). `coder-start.sh` will error if the file is missing.

---

## Sandbox Layout

After sandbox creation (`createSandbox`):

```
/tmp/saifac/{proj}-{feat}-{runId}/
  gate.sh       ← always written; mounted :ro at /saifac/gate.sh
  startup.sh    ← always written from profile or --startup-script; mounted :ro at /saifac/startup.sh
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
saifac feat run
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
saifac feat run --startup-script ./scripts/my-startup.sh
```

For a resume (continue):

```bash
saifac run resume <runId> --startup-script ./scripts/my-startup.sh
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
saifac feat run \
  --startup-script ./scripts/my-startup.sh \
  --gate-script ./scripts/factory-gate.sh
```

---

## Step-by-Step: Custom Coder Agent (extend coder-base)

**Problem:** You want to use claude-code or another coder instead of OpenHands.

### Step 1: Build the base image

```bash
pnpm docker build coder-base
```

This produces `saifac-coder-base:latest`. (The default coder image is pulled from GHCR when omitted — extend only when bringing your own coder agent.)

### Step 2: Create your custom Dockerfile

Create `Dockerfile.my-coder` in your repo:

```dockerfile
FROM saifac-coder-base:latest

# Install your coder agent here.
# Example for claude-code (adjust for your tool):
RUN npm install -g @anthropic-ai/claude-code
# or: RUN uv tool install openhands
# or: whatever your coder requires
```

### Step 3: Build and use

```bash
docker build -f Dockerfile.my-coder -t my-saifac-coder:latest .
saifac feat run --coder-image my-saifac-coder:latest
```

**Note:** `coder-start.sh` invokes `openhands` by name. If your coder has a different CLI, you would need to either fork `coder-start.sh` or add a configurable agent command (future enhancement).

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
saifac feat run \
  --startup-script ./scripts/my-startup.sh \
  --gate-script ./scripts/factory-gate.sh
```

---

## CLI Reference

| Flag               | Subcommands                        | Description                                                                                                                                                                              |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--model`          | saifac feat run, saifac run resume | LLM model override (e.g. anthropic/claude-sonnet-4-5). Falls back to `LLM_MODEL` env.                                                                                                    |
| `--provider`       | saifac feat run, saifac run resume | LLM provider ID (e.g. anthropic, openai, openrouter). Forwarded as `LLM_PROVIDER`. Used by agents like opencode for base URL / routing when `LLM_MODEL` is not in provider/model format. |
| `--base-url`       | saifac feat run, saifac run resume | LLM base URL override (e.g. https://openrouter.ai/api/v1). Falls back to `LLM_BASE_URL` env.                                                                                             |
| `--profile`        | saifac feat run, saifac run resume | Sandbox profile; sets the installation script (and other defaults).                                                                                                                      |
| `--startup-script` | saifac feat run, saifac run resume | Path to script run once before the agent loop (overrides profile).                                                                                                                       |
| `--gate-script`    | saifac feat run, saifac run resume | Path to script run after each agent round. Default: built-in pnpm check.                                                                                                                 |
| `--gate-retries`   | saifac feat run, saifac run resume | Max gate retries per run (default: 5).                                                                                                                                                   |
| `--coder-image`    | saifac feat run, saifac run resume | Docker image for the coder container (default: from profile, e.g. saifac-coder-node-pnpm-python:latest).                                                                                |

---

## Security

- **Startup and gate scripts** are mounted `:ro` — the agent cannot modify them.
- **`coder-start.sh`** is baked into the image — not injected per-run; the agent cannot reach it.
- Scripts run inside the container with access to `/workspace` only; no additional host trust surface.
