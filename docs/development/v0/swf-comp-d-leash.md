# Software Factory Component D2: Leash by StrongDM

## What is Leash?

Provision safe Docker containers for AI agents. All network and filesystem
access is monitored and can be restricted via Cedar.

**[Leash](https://github.com/strongdm/leash)** is an open-source security framework built by StrongDM specifically designed to provide authorization, visibility, and control over autonomous AI agents.

While tools like Docker provide basic containerization (keeping the agent off your host filesystem), Leash acts as a **Policy Enforcement Engine**. It intercepts an agent's runtime activity in real-time—including file system access, network requests, and Model Context Protocol (MCP) tool usage—and evaluates them against fine-grained security policies.

## How It Works (Architecture)

Leash wraps the AI agent's execution environment. It uses **[Cedar](https://www.cedarpolicy.com/)** to define strict, readable rules about what the agent is allowed to do.

1. **Interception:** As the agent runs (e.g., executing a bash script, making an HTTP request, or
   modifying a file), Leash intercepts the underlying system calls or API requests.
2. **Evaluation:** Leash instantly evaluates the action against the active Cedar policies.
3. **Enforcement:** If the action is permitted, it executes normally. If the action is forbidden (e.g.,
   an agent trying to delete `/saifctl/` or curl a crypto-mining IP), Leash instantly blocks the action
   and returns an error (like `HTTP 403 Forbidden` or a file permission error) back to the agent.
4. **Telemetry:** Every action, permitted or denied, is logged, giving developers and security teams
   perfect observability into the "black box" of the agent's thought process.

See Cedar rules available for Leash [here](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.
md).

## WHY We Are Using It

In an autonomous Software Factory, the Coder Agent is placed in a continuous looping environment (often
10 to 50 iterations) with no human supervision. This presents immense risks:

- **Reward Hacking:** The easiest way for an LLM to make a test pass is to rewrite the test itself.
  Leash physically prevents the agent from modifying holdout tests or the test runner infrastructure.
- **Supply Chain Security:** Agents run `npm install` blindly. If an agent hallucinates a package name
  or installs a compromised package, Leash's network policies can block malicious post-install scripts
  from phoning home to bad actors.
- **Runaway Cost & Destruction:** If an agent gets stuck in a loop deleting project files or spamming
  external APIs, Leash's boundaries ensure the damage is contained and instantly flagged.
- **MCP Governance:** As we add more tools to our agents via Model Context Protocol, Leash provides a
  centralized way to authorize which agent can use which tool.

## Usage

When Leash is enabled, the Orchestrator runs the **Leash CLI** (`@strongdm/leash`) with the same argv shape as below.

```bash
leash --no-interactive --verbose
      --image saifctl-coder-node-pnpm-python:latest
      --volume /tmp/saifctl/sandboxes/<feat>-<runId>/code:/workspace
      --policy policies/default.cedar
      --env LLM_MODEL=... --env LLM_API_KEY=... [--env LLM_PROVIDER=...] [--env LLM_BASE_URL=...] --env SAIFCTL_WORKSPACE_BASE=/workspace
      /saifctl/coder-start.sh
```

To try the same from a shell, use e.g. `pnpm exec leash …` or `npx --package @strongdm/leash leash …` from a directory where dependencies are installed.

Leash spawns two containers:

1. **Leash manager container** (`agents-leash`) — runs `leashd`, enforces Cedar policy, monitors activity, serves the Control UI at `http://localhost:18080`.
2. **Target container** (`agents`) — runs our custom `saifctl-coder` image with OpenHands inside. Mounts `/workspace` (the sandbox copy).

Leash is a **CLI wrapper**. You do not pull or run any StrongDM Docker image yourself — Leash manages its own Docker containers when you invoke it.

## Current Integration Status

**Leash is enabled by default** for `saifctl feat run` and `saifctl run start`. The integration is complete and working.

### Custom Coder Image

StrongDM's reference `public.ecr.aws/s5i7k8t3/strongdm/coder` image bundles several npm-based CLIs; **our published `saifctl-coder-*` images do not use that base.** Each profile's `Dockerfile.coder` starts from an upstream image (Node, Python, golang, rust, Miniconda, etc.). Node-based agents (Claude Code, Codex, Gemini CLI, …) are installed at run time by their `agent-install.sh` via `npm install -g` when missing, or you can bake them into a custom `--coder-image`.

**Default image `saifctl-coder-node-pnpm-python:latest`** includes Node 25, pnpm, Python 3, pipx, and uv (see `src/sandbox-profiles/node-pnpm-python/Dockerfile.coder`). **OpenHands** is installed by `agent-install.sh` when you use the openhands agent profile (not baked into the image).

**Build:** `pnpm docker build coder` (uses the sandbox profile's `Dockerfile.coder`; default: node-pnpm-python).
**Default:** Images are published to GHCR. Docker pulls them automatically when not present locally.

### Network enforcement

Leash enforces outbound connectivity using its MITM proxy and Cedar `NetworkConnect` rules (see [Leash Cedar design](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md) — resources use `Host::"hostname"`). HTTPS clients inside the target container must trust the Leash CA (the harness configures this where needed so tools like `pnpm`/`curl` can reach allowed hosts). Tighten or relax allowlists by editing the active Cedar file (`--cedar`, default `src/orchestrator/policies/default.cedar`). For experiments, see `src/orchestrator/policies/deny-network.cedar`.

### What Leash Provides (Active)

| Layer                 | Mechanism                                                                      | Status |
| --------------------- | ------------------------------------------------------------------------------ | ------ |
| Container isolation   | OpenHands runs inside a Docker container; host repo is never touched           | Active |
| Filesystem monitoring | Leash logs file access; Cedar policy can forbid writes to `/workspace/saifctl/` | Active |
| Network policy        | Cedar `NetworkConnect` + Leash proxy / kernel path                             | Active |
| Control UI            | `http://localhost:18080` — audit trail, telemetry                              | Active |

### What We Rely On

- **Pure file copy sandbox** — `rsync` copies the repo to `/tmp/saifctl/sandboxes/.../code`; agent only sees that copy.
- **Cedar policy** — `src/orchestrator/policies/default.cedar` uses [Leash’s Cedar schema](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md): `FileOpen` / `FileOpenReadOnly` under `Dir::"/"` (read whole container for bootstrap and tooling); `FileOpenReadWrite` under `Dir::"/workspace/"` and `Dir::"/tmp/"`; `forbid` `FileOpenReadWrite` under `/workspace/saifctl/` and `.git/`; `ProcessExec` under `Dir::"/"`; `NetworkConnect` via `Host::"*"`. Use `--cedar` for hostname-scoped network rules.
- **Patch filtering** — any `saifctl/` changes are dropped before the patch is applied to the host.

---

## Cedar Policy (Default)

We ship default policies under `src/orchestrator/policies/` (`default.cedar`, `deny-network.cedar`):

- **Filesystem** — read opens (`FileOpen`, `FileOpenReadOnly`) under `Dir::"/"`; `FileOpenReadWrite` under `Dir::"/workspace/"` and `Dir::"/tmp/"`; `FileOpenReadWrite` forbidden under `Dir::"/workspace/saifctl/"` and `Dir::"/workspace/.git/"`
- **ProcessExec** — permitted under `Dir::"/"` (system binaries on `PATH`)
- **Network** — `NetworkConnect` allowed for `Host::"*"`; override with `--cedar` for hostname allowlists (`deny-network.cedar` is one example)

Override with `--cedar <path>` when running `saifctl feat run` or `saifctl run start`.

---

## CLI Options

| Option                    | Purpose                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--engine local`           | Coding engine **local** (LocalEngine): run OpenHands **on the host** (filesystem sandbox only).                             |
| `--dangerous-no-leash`    | Skip Leash and Cedar; run the **same coder image** with **`docker run`** (bind mounts, env, working dir, and container name match Leash). No policy proxy or Control UI. |
| `--cedar <path>`          | Custom Cedar policy file (default: `src/orchestrator/policies/default.cedar`). Ignored when Leash is not used (`--dangerous-no-leash` or local coding). |
| `--coder-image <tag>`     | Custom target container image (default: from `--profile`, e.g. `saifctl-coder-node-pnpm-python:latest`).                                 |

### `--dangerous-no-leash` (Docker without Leash)

Use this when you need to debug or compare behavior **inside the coder container** but **without** Leash’s Cedar enforcement, MITM proxy, or manager sidecar (`agents-leash`). The factory still uses the normal sandbox copy and the same **target** image and mount layout as a Leash run.

**Behavior (summary):**

- **Invocation:** `docker run` (interactive, `--rm`) instead of the Leash CLI. There is **no** `agents-leash` container and **no** Cedar evaluation for filesystem or network.
- **Parity with Leash target:** Same **container name** as Leash’s workload container (`leash-target-<workspaceId>`), **`-w /workspace`**, coder image (`--coder-image` / profile default), and **volume mounts** for the workspace, bundled `saifctl/` assets, and (when reviewer mode is on) the same Argus/reviewer mounts and env as the Leash path. LLM and forwarded API keys (e.g. `LLM_*`, `DASHSCOPE_API_KEY`, reviewer keys) are passed through **`-e`** like the Leash integration.
- **Network:** If the factory’s Docker bridge network for SaifCTL exists, the container is attached to it (same idea as normal runs); Leash-specific **network attach** steps are skipped.
- **Hardening:** The direct run uses **`--cap-drop=ALL`** and **`--security-opt=no-new-privileges`** (defense in depth without replacing Leash policy).
- **Cleanup:** On failure, timeout, or abort, the orchestrator best-effort removes the named target container (`docker rm -f`).

**Config default:** You can set `defaults.dangerousNoLeash` in the factory config schema; CLI still wins when you pass the flag explicitly where supported.

**Resume / Hatchet:** The flag is stored in run metadata and propagated through distributed (`feat-run`) workflows so resume and workers behave consistently.

**Do not use in production** for untrusted workloads: there is no Cedar or Leash proxy—outbound access is whatever the container and host Docker networking allow.

---

## Installation & Day-to-Day

### Leash

Leash is an npm **dependency** of safe-ai-factory (`@strongdm/leash`). The orchestrator resolves `bin/leash.js` from that package and runs it with **`node`**, so it works when safe-ai-factory is installed as a dependency and when `cwd` is the sandbox. Optional override: **`SAIFCTL_LEASH_BIN`**. Prebuilt native pieces ship for darwin/linux amd64/arm64.

### OpenHands

OpenHands must be on PATH for the target container. It is pre-installed in `saifctl-coder`. For `--dangerous-no-leash`, behavior matches a normal container run (image + `agent-install.sh` as usual). For **local coding** (LocalEngine / `--engine local`), install on the host:

```bash
uv tool install openhands --python 3.12
```

### First Run

1. **Test Runner image** — pulled from GHCR when not present locally (e.g. `ghcr.io/JuroOravec/safe-ai-factory/saifctl-test-node-vitest:latest`).
2. **Coder image** — pulled from GHCR when not present locally (e.g. `ghcr.io/JuroOravec/safe-ai-factory/saifctl-coder-node-pnpm-python:latest` for the default sandbox profile).

---

## Telemetry & Debugging

- **Control UI:** `http://localhost:18080` when Leash is running (not available with `--dangerous-no-leash`).
- **Target logs:** `docker logs -f agents` (Leash default target name) or `docker logs -f leash-target-<workspaceId>` when correlating with factory runs (including `--dangerous-no-leash`).
- **Leash logs:** `docker logs -f agents-leash`
- **Stop:** `docker rm -f agents agents-leash` (Leash); for `--dangerous-no-leash`, the factory removes the named `leash-target-*` container on exit or you can `docker rm -f` it manually.

---

## Reference: Cedar Rules

See [Leash Cedar design](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md) for action types (`FileOpen`, `FileOpenReadOnly`, `FileOpenReadWrite`, `ProcessExec`, `NetworkConnect`, `HttpRewrite`, `McpCall`) and resource types (`Dir::"/path/"`, `File::"/path"`, `Host::"example.com"`, etc.). Leash does **not** use `ReadFile` / `WriteFile` or `Directory::` — those map to the `FileOpen*` family and `Dir::`.
