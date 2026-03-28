# Distributed Architecture Plan: SaifCTL Control Plane

## Overview

This document describes the plan for evolving SaifCTL from a single-machine CLI tool into a
**distributed, multi-tenant control plane** — a centralized server that manages agent runs across
many machines, teams, or cloud environments, with a dashboard for monitoring, logs, and control.

The reference design is Leash's own control server (`localhost:18080`), but applied at the scale of
an entire organization's AI engineering operations.

---

## Goals

1. **Centralized observability** — All agent runs, logs, and audit trails visible in one place.
2. **Distributed execution** — Runs can be dispatched to remote worker nodes (cloud VMs, K8s pods,
   CI runners) rather than only on the local machine.
3. **Dynamic worker provisioning** — Workers are spun up on demand and torn down when idle, so users
   pay only for what they use.
4. **Multi-user, multi-project support** — Teams, cost quotas, RBAC.
5. **Webhook triggers** — GitHub issues/comments, Jira, Slack → trigger runs without `saifctl` CLI.

---

## Technology Choice: Hatchet

We use **[Hatchet](https://hatchet.run)** as the workflow/task queue backbone. Hatchet is an
open-source, self-hostable durable-execution engine with:

- A built-in dashboard (runs, steps, logs, retries, replay).
- TypeScript SDK — matches the existing SaifCTL codebase.
- Fan-out / step DAGs — maps naturally to the SaifCTL orchestrator loop (coding → gate → reviewer →
  test → merge).
- Worker-side pull model — workers long-poll for tasks; they do NOT need a publicly reachable port,
  only outbound access to the Hatchet server.
- Durable retries, timeouts, and cancellation built in.
- Self-hostable via Docker Compose or Helm (no vendor lock-in).

### Worker availability

Hatchet uses a **pull model**: workers connect to the Hatchet server and ask for tasks. This means:

- Workers do **not** need to run continuously. You can spin one up only when a task is queued.
- Workers can be provisioned dynamically (e.g. a GitHub Actions job, an ECS task, a Fly.io Machine
  started by a webhook) and torn down when idle.
- A `saifctl worker start` command connects the local machine as a worker — useful for individual
  developers who want to run agents locally without a persistent server.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SaifCTL Control Plane                     │
│                                                             │
│  ┌─────────-────┐   ┌───────────────┐   ┌────────────────┐  │
│  │  API Server  │   │   Hatchet     │   │   Dashboard    │  │
│  │  (REST/WS)   │◄──│   Server      │──►│   (Next.js /   │  │
│  │              │   │   (workflow   │   │   Hatchet UI)  │  │
│  │  - Auth      │   │   engine)     │   │                │  │
│  │  - Projects  │   │               │   │  - Run list    │  │
│  │  - Features  │   │               │   │  - Step logs   │  │
│  │  - Runs API  │   │               │   │  - Audit trail │  │
│  └──────┬───────┘   └───────┬───────┘   └────────────────┘  │
│         │                   │                               │
└─────────┼───────────────────┼───────────────────────────────┘
          │                   │
          │         ┌─────────▼──────────┐
          │         │  Worker Node(s)    │
          │         │                    │
          │         │  saifctl worker     │
          │         │  - pulls tasks     │
          │         │  - spins Docker    │
          │         │  - runs Leash      │
          │         │  - reports logs    │
          │         │                    │
          │         │  [Local machine]   │
          │         │  [Cloud VM]        │
          │         │  [K8s pod]         │
          │         │  [CI runner]       │
          └────────►└────────────────────┘
               webhooks / GitHub App
```

---

## Data Schemas

### `Project`

```typescript
interface Project {
  id: string; // uuid
  slug: string; // e.g. "my-app"
  name: string;
  repoUrl: string; // git clone URL
  defaultBranch: string;
  ownerTeamId: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### `Feature`

```typescript
interface Feature {
  id: string;
  projectId: string;
  name: string; // e.g. "add-login"
  specRef: string; // path to spec file in repo
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  taskRef?: string; // e.g. GitHub issue URL
  createdAt: Date;
  updatedAt: Date;
}
```

### `Run`

Extends the existing local `RunArtifact` schema to add distributed-execution fields.

```typescript
interface Run {
  // Identity
  id: string; // e.g. "add-login-r1"
  featureId: string;
  projectId: string;

  // Execution
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  workerId?: string; // which worker picked this up
  hatchetWorkflowRunId?: string; // Hatchet's own run ID for dashboard deep-link

  // Git state (same as local RunArtifact)
  baseCommitSha: string;
  basePatchDiff: string;
  runCommits: { message: string; diff: string; author?: string }[];

  // Context
  specRef: string;
  lastFeedback?: string;

  // Config snapshot (serialized inputs, not generated outputs)
  config: RunConfig;

  // Timing
  startedAt: Date;
  updatedAt: Date;
  finishedAt?: Date;

  // Cost tracking
  tokensUsed?: number;
  estimatedCostUsd?: number;
}

interface RunConfig {
  agent: string; // e.g. "openhands"
  model: string; // e.g. "anthropic/claude-sonnet-4-5"
  maxIterations: number;
  cedarPolicy?: string; // path or inline policy
  coderImage?: string;
  sandboxProfile?: string;
  storageBackend: string;
}
```

### `WorkerNode`

```typescript
interface WorkerNode {
  id: string;
  label: string; // human-readable, e.g. "macbook-juro" or "aws-us-east-1-worker-3"
  status: 'online' | 'busy' | 'offline';
  capabilities: {
    maxConcurrentRuns: number;
    runtimes: string[]; // e.g. ["node", "python", "go"]
    dockerAvailable: boolean;
    gpuAvailable: boolean;
  };
  lastSeenAt: Date;
  registeredAt: Date;
}
```

### `AuditEvent`

Centralized stream of all agent activity (Leash telemetry + orchestrator lifecycle events).

```typescript
interface AuditEvent {
  id: string;
  runId: string;
  projectId: string;

  type:
    | 'run.queued'
    | 'run.started'
    | 'run.step.started' // coding | gate | reviewer | test
    | 'run.step.finished'
    | 'run.succeeded'
    | 'run.failed'
    | 'run.cancelled'
    | 'leash.file.read'
    | 'leash.file.write'
    | 'leash.file.write.denied'
    | 'leash.network.connect'
    | 'leash.network.denied'
    | 'leash.process.exec';

  payload: Record<string, unknown>; // type-specific data
  severity: 'info' | 'warn' | 'error';
  timestamp: Date;
}
```

### `LogLine`

Streaming log lines from agents/containers, stored per-run.

```typescript
interface LogLine {
  runId: string;
  step: 'agent' | 'gate' | 'reviewer' | 'test_runner' | 'orchestrator';
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: Date;
}
```

---

## Hatchet Workflow Definition

The SaifCTL orchestrator loop becomes a **Hatchet workflow** where each phase is a durable step.

### What is (and isn't) a Hatchet step

It's important to understand the layering before modelling this as steps:

- The **gate** (`gate.sh`) and **reviewer** (Argus) run **inside** `codingEngine.runAgent()` —
  they are sub-steps of the inner shell loop within the Leash/coder container itself. From the
  orchestrator's point of view, `runAgent()` is a single atomic call. The gate/reviewer are not
  separate Hatchet steps; they live entirely inside the coding container and their results are
  consumed by that same container to decide whether to retry or exit.

- The **orchestrator-level** steps are coarser:
  1. Provision sandbox (rsync, git init, holdout removal)
  2. One iteration: `runAgent` (which internally runs agent → gate → reviewer → repeat) + extract
     patch + `runTests` (staging + test runner containers)
  3. On success: apply patch + push + PR

Each iteration of the convergence loop is modelled as a **child workflow** spawned by the parent,
so Hatchet can track per-iteration status and logs independently.

```typescript
// src/hatchet/workflows/feat-run.workflow.ts

import Hatchet from '@hatchet-dev/typescript-sdk';

const hatchet = Hatchet.init();

// ── Parent workflow ──────────────────────────────────────────────────────────
// Owns the sandbox lifecycle and the convergence loop.
// Spawns a child workflow per iteration.

export const featRunWorkflow = hatchet.workflow({
  name: 'feat-run',
  on: { event: 'run:trigger' },
});

featRunWorkflow.task({ name: 'provision-sandbox', timeout: '5m' }, async (ctx) => {
  const { runId, featureId, config } = ctx.workflowInput();
  // rsync repo to sandbox dir, strip holdout tests, git init — orchestrator/sandbox.ts
  return createSandbox(/* opts from workflow input / OrchestratorOpts */);
});

featRunWorkflow.task(
  {
    name: 'convergence-loop',
    timeout: '3h',
    after: ['provision-sandbox'],
  },
  async (ctx) => {
    // Spawns up to maxRuns child workflows sequentially.
    // Each child is one attempt: runAgent (inner gate/reviewer loop) + runTests.
    // Stops early if a child returns passed=true.
    const { sandboxPath } = ctx.stepOutput('provision-sandbox');
    for (let attempt = 1; attempt <= maxRuns; attempt++) {
      const result = await ctx
        .spawnWorkflow('feat-run-iteration', {
          attempt,
          sandboxPath,
          ...ctx.workflowInput(),
        })
        .result();
      if (result.passed) return { passed: true, attempt };
    }
    return { passed: false };
  },
);

featRunWorkflow.task(
  {
    name: 'apply-and-merge',
    timeout: '5m',
    after: ['convergence-loop'],
  },
  async (ctx) => {
    const { passed, attempt } = ctx.stepOutput('convergence-loop');
    if (!passed) return; // max runs exhausted; run is already saved as failed
    // apply patch to host repo via git worktree, push branch, open PR
    await applyPatchToHost({ ...ctx.workflowInput(), attempt });
  },
);

// ── Child workflow (one iteration) ──────────────────────────────────────────
// Steps here map to the two orchestrator-level phases per attempt.
// The gate and reviewer are NOT steps here — they run inside runAgent() within
// the Leash container and are invisible to the Hatchet scheduler.

export const iterationWorkflow = hatchet.workflow({ name: 'feat-run-iteration' });

iterationWorkflow.task(
  {
    name: 'run-agent',
    // Timeout must cover: coding agent + inner gate retries + inner reviewer calls
    // (all of which happen inside the Leash container process, not as separate tasks).
    timeout: '60m',
  },
  async (ctx) => {
    const { sandboxPath, config } = ctx.workflowInput();
    // Calls codingEngine.setup() + runAgent() + teardown().
    // runAgent() internally: spawns Leash CLI (`node …/leash.js …`), which itself
    //   runs the coder-start.sh loop (agent → gate.sh → reviewer → repeat).
    // Returns patch diff when the inner loop exits (pass or exhausted gate retries).
    const patch = await runAgentPhase(sandboxPath, config);
    return { patch };
  },
);

iterationWorkflow.task(
  {
    name: 'run-tests',
    timeout: '20m',
    after: ['run-agent'],
  },
  async (ctx) => {
    const { patch } = ctx.stepOutput('run-agent');
    const { sandboxPath, config } = ctx.workflowInput();
    // Spins staging container + test-runner container; returns JUnit XML + pass/fail.
    const result = await runTestPhase(sandboxPath, patch, config);
    return { passed: result.passed, feedback: result.feedback };
  },
);
```

Each step streams logs back to the Hatchet server so the dashboard shows real-time step status and
logs — without any custom dashboard code needed for the basic view.

---

## Worker Node Design

A worker is a long-running process that:

1. Registers itself with the Hatchet server (HTTP POST → persisted in `WorkerNode` table).
2. Starts the Hatchet worker SDK and long-polls for tasks.
3. On receiving a task, executes the corresponding workflow step locally (Docker, Leash, etc.).
4. Streams logs back to the control plane over the Hatchet event stream.
5. Reports Leash telemetry by forwarding Leash's audit log to the AuditEvent table.

```bash
# Start a worker on any machine that has Docker
saifctl worker start --server https://saifctl.mycompany.com --token $WORKER_TOKEN
```

### Dynamic provisioning (no always-on workers required)

Workers do not need to be always running. Two patterns:

**Pattern A: On-demand cloud VM (AWS/GCP/Hetzner)**

```
GitHub webhook → API Server → enqueue Hatchet task
                                     ↓
                        Hatchet event: "task queued"
                                     ↓
               Lambda/Cloud Function: launch spot VM with cloud-init
                                     ↓
               VM boots → `saifctl worker start --ephemeral` → picks up task
                                     ↓
               Task done → worker exits → VM terminates (cost: ~zero idle)
```

**Pattern B: GitHub Actions (cheapest to start)**

```yaml
# .github/workflows/saifctl-worker.yml
on:
  repository_dispatch:
    types: [saifctl-run-queued]

jobs:
  worker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx saifctl worker start --ephemeral --server ${{ vars.SAIFCTL_SERVER }}
        env:
          WORKER_TOKEN: ${{ secrets.WORKER_TOKEN }}
```

The API server fires a `repository_dispatch` event when a run is queued, which starts a GitHub
Actions runner. The runner connects as a worker, picks up exactly the queued task, and exits when
done. No idle cost.

**Pattern C: K8s Job (enterprise)**

The Hatchet server's worker health endpoint triggers a K8s CronJob or a custom operator to launch
a Job pod per task.

---

## Control Plane API (REST)

```
POST   /api/projects                    # create project
GET    /api/projects/:id/runs           # list runs
POST   /api/projects/:id/runs           # trigger run (returns runId)
GET    /api/runs/:id                    # run detail + status
GET    /api/runs/:id/logs               # streaming logs (SSE)
GET    /api/runs/:id/audit              # Leash audit trail for this run
POST   /api/runs/:id/cancel             # cancel in-flight run
POST   /api/runs/:id/resume             # resume failed run (same as CLI)

GET    /api/workers                     # list registered workers
GET    /api/dashboard/stats             # aggregate metrics

# Webhooks (inbound)
POST   /webhooks/github                 # GitHub App events
POST   /webhooks/gitlab                 # GitLab events
```

---

## Dashboard Features

The Hatchet-managed UI covers the basics (run list, step graph, logs) out of the box. SaifCTL adds
a thin layer on top:

| Panel           | What it shows                                                                            |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Runs**        | All runs across all projects; filterable by project, status, date                        |
| **Run detail**  | Step-by-step graph (provision → agent → gate → reviewer → test → merge), live log stream |
| **Audit trail** | Per-run Leash audit events (file reads/writes, network calls, denials)                   |
| **Workers**     | Online/offline workers, current load, capabilities                                       |
| **Projects**    | Project list, run history, cost breakdown                                                |
| **Cost**        | Token usage and estimated cost per team/project/run                                      |

---

## Storage Backends

Run artifacts and logs use the same backends as the existing `--storage` flag, now also accessible
from the server:

| Backend              | When to use                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| `local`              | Single-developer, runs on same machine                                              |
| `s3` / `s3://bucket` | Multi-worker, shared artifact store; workers upload → server downloads on resume    |
| `postgres` (new)     | Control plane stores `Run`, `AuditEvent`, `LogLine` rows; enables dashboard queries |

When running in distributed mode the recommended setup is:

- **Artifact blobs** (patch diffs, git state) → S3-compatible store (S3, R2, MinIO).
- **Structured data** (run metadata, audit events) → Postgres.
- **Log streaming** → Hatchet's own event stream (forwarded to Postgres for persistence).

---

## Implementation Phases

### Phase 1 — Local Hatchet (single machine, optional local server)

Refactor `src/orchestrator/loop.ts` into a Hatchet workflow. UX is identical to today —
`saifctl feat run` works the same — but the loop is now durable, retryable, and visible in the
Hatchet dashboard when a server is running.

> **Infra note:** Hatchet has no embedded/SQLite mode. It always requires a running server
> (Postgres + engine). For singleplayer use, `hatchet server start` spins up a Docker-based
> local server (Hatchet Lite). This is optional — `saifctl feat run` falls back to the existing
> in-process loop when no `HATCHET_CLIENT_TOKEN` is configured (see step 1.1 below).

**Deliverables:**

- `src/hatchet/workflows/feat-run.workflow.ts` — workflow + step definitions
- `src/hatchet/client.ts` — Hatchet client singleton (reads env, returns null if not configured)
- Fallback path: when Hatchet is not configured, the existing `loop.ts` runs as-is (no regression)
- Docs: how to start the local Hatchet server and view the dashboard

---

#### Step 1.1 — Add Hatchet SDK; add opt-in detection

```bash
pnpm add @hatchet-dev/typescript-sdk
```

In `src/hatchet/client.ts`:

```typescript
// Returns a configured Hatchet client, or null when HATCHET_CLIENT_TOKEN is not set.
// This makes Hatchet purely opt-in for Phase 1 — no token = existing loop runs unchanged.
export function getHatchetClient(): Hatchet | null {
  if (!process.env.HATCHET_CLIENT_TOKEN) return null;
  return Hatchet.init();
}
```

No existing behaviour changes in this step.

---

#### Step 1.2 — Extract loop body into pure, Hatchet-agnostic functions

`loop.ts` currently has `runIterativeLoop()` as one large async function. Split it into
three pure async functions that can be called from either the existing loop or a Hatchet step:

```
src/orchestrator/
  sandbox.ts              createSandbox(opts) → Sandbox  (Hatchet provision-sandbox step calls this)
src/orchestrator/phases/
  run-agent-phase.ts      runAgentPhase(sandbox, opts) → { patch: string }
  run-test-phase.ts       runTestPhase(sandbox, patch, opts) → TestsResult
  apply-patch.ts          (already exists: applyPatchToHost — move here from loop.ts)
```

`runIterativeLoop()` is refactored to call these functions in sequence, keeping the existing
`while (attempts < maxRuns)` logic intact. No change to external callers (`modes.ts`).

---

#### Step 1.3 — Define the Hatchet workflow

`src/hatchet/workflows/feat-run.workflow.ts`:

- **Parent workflow `feat-run`**: steps `provision-sandbox`, `convergence-loop`,
  `apply-and-merge`.
- **Child workflow `feat-run-iteration`**: steps `run-agent`, `run-tests`, and `vague-specs-check`.
  Each step calls the corresponding phase function from step 1.2 (tests are raw; hint comes from the vague-specs step).
  Step input/output types are plain JSON-serialisable objects — no class instances.

Input schema (Zod):

```typescript
const FeatRunInput = z.object({
  runId: z.string(),
  featureId: z.string(),
  projectDir: z.string(),
  config: SerializedLoopOptsSchema, // already exists in src/runs/utils/serialize.ts
});
```

---

#### Step 1.4 — Dual-path dispatch in `modes.ts`

In `runStartCore()` (the entry point called by `saifctl feat run`):

```typescript
const hatchet = getHatchetClient();

if (hatchet) {
  // Hatchet path: register worker + dispatch workflow; wait for result
  const worker = await hatchet.worker('saifctl-worker', { workflows: [featRunWorkflow] });
  await worker.start();
  const run = await hatchet.admin.runWorkflow('feat-run', input);
  result = await run.result();
} else {
  // Existing path: unchanged
  result = await runIterativeLoop(sandbox, opts);
}
```

`saifctl feat run` without `HATCHET_CLIENT_TOKEN` is 100% identical to today.

---

#### Step 1.5 — Input/output serialisation for Hatchet steps

Hatchet passes step inputs/outputs as JSON. The existing `SerializedLoopOpts` (in
`src/runs/utils/serialize.ts`) is almost sufficient but needs:

- `Sandbox` serialised/deserialised (currently a plain object — likely fine already).
- `patch` (string diff) passed between `run-agent` → `run-tests` steps.
- Test result (pass/fail, feedback string) passed from `run-tests` back to the parent loop.

Extend `serialize.ts` with these types; add Zod schemas for step I/O validation.

---

#### Step 1.6 — Wire up `run-agent` step timeout and cancellation

`runAgentPhase` can run up to 60 min. Hatchet task timeout must be set explicitly:

```typescript
iterationWorkflow.task({ name: 'run-agent', timeout: '60m' }, ...);
```

Cancellation: Hatchet sends a cancellation signal to the step function's `ctx`. The step
must call `codingEngine.teardown()` in a `finally` block — this is already done in
`loop.ts`, so no new logic is needed; just ensure it runs inside the step function.

---

#### Step 1.7 — Ctrl+C / signal handling

Currently `modes.ts` installs `SIGINT`/`SIGTERM` handlers via `CleanupRegistry`. When
running under Hatchet, the worker process owns signal handling. Two changes:

- In the Hatchet path, skip the `CleanupRegistry` signal handlers (Hatchet handles shutdown).
- Pass the Hatchet step `ctx` cancellation token to `runAgentPhase` / `runTestPhase` so
  containers are torn down when a workflow is cancelled from the dashboard.

---

#### Step 1.8 — Run artifact save-on-failure via Hatchet step output

Today `loop.ts` saves a `RunArtifact` to storage in its `finally` block on failure.
In the Hatchet path:

- The `run-agent` child step returns **`commits`**: an array of `RunCommit` objects (one per sandbox commit on the first-parent chain for that attempt, plus an optional WIP `RunCommit`), plus combined `patchContent` for the test phase. On failure or abort, the parent pops **`agentOut.commits.length`** entries from `runCommitsAccum` (same as local `loop.ts` with `roundCommitCount`).
- The parent `convergence-loop` step updates `run-commits.json` after each attempt and, on failure paths, builds/saves a `RunArtifact` via `runStorage.saveRun()` (see `feat-run.workflow.ts`).
- Same `RunArtifact` schema as today — `saifctl run start` continues to work unchanged.

---

#### Step 1.9 — Local server docs + `saifctl doctor` check

Add a `saifctl doctor` (or extend existing) command that checks:

- Docker running
- `HATCHET_CLIENT_TOKEN` set (optional — prints "Hatchet not configured, running in local mode")
- If token set: verify gRPC connectivity to `HATCHET_SERVER_URL`

Add a short doc page `docs/hatchet.md`:

```
## Quick start (local dashboard)

# 1. Install Hatchet CLI
npm install -g @hatchet-dev/cli

# 2. Start local Hatchet server (requires Docker)
hatchet server start

# 3. Copy the generated token shown in the output
export HATCHET_CLIENT_TOKEN=<token>
export HATCHET_SERVER_URL=localhost:7077

# 4. Run as normal — now with durability + dashboard
saifac feat run -n my-feature
# Open http://localhost:8888 to watch the run
```

---

## Open Questions / Decisions

1. **Singleplayer vs distributed Hatchet:** These are two separate modes, not a Cloud vs
   self-hosted choice:
   - **Singleplayer (Phase 1):** Embedded local Hatchet instance (sqlite-backed, single binary).
     No account, no URL, no config. `saifctl feat run` works exactly as today — Hatchet is purely
     an internal implementation detail that adds durability and a local dashboard.
   - **Distributed (Phase 2+):** SaifCTL becomes a Hatchet client. The user supplies
     `HATCHET_SERVER_URL` and `HATCHET_CLIENT_TOKEN`. Whether that URL points to Hatchet Cloud,
     a self-hosted instance, or a company-managed cluster is entirely their responsibility. SaifCTL
     ships no Hatchet server for this mode.

2. **Dashboard: use Hatchet UI first.** ✓ Resolved. Hatchet's built-in UI covers run list,
   step graph, and log streaming out of the box. SaifCTL-specific panels (Leash audit trail,
   Cedar denials, cost per run) are added later as supplementary views alongside the Hatchet UI —
   no need to rebuild what Hatchet already provides.

3. **Log storage at scale:** ✓ Resolved. Hatchet handles step logs natively — sufficient for most
   users. Our additional responsibility is **telemetry Hatchet doesn't see**: orchestrator lifecycle
   plus, optionally, **Leash-native** file/network audit (Leash runs in a sidecar on the worker, not
   inside Hatchet steps). See item 5 — Leash has **no** built-in audit webhook; wiring those events
   in is integration work (e.g. tail `LEASH_LOG` or mirror the Control UI WebSocket).
   - **SaifCTL's job:** Emit structured `AuditEvent` JSON (orchestrator + optional Leash-derived) to a
     configurable `SAIFCTL_AUDIT_WEBHOOK_URL`. We own the emission side only.
   - **User's job:** Wire that webhook to whatever backend they already operate — Loki, Datadog,
     Splunk, ClickHouse, or nothing. Off-the-shelf log shippers (Vector, Fluent Bit) can consume
     the webhook and route it without any custom code.
   - We do not bundle or require a specific log storage backend.

4. **Worker authentication:** ✓ Resolved. Hatchet owns this entirely — no auth machinery needed
   on our side. The flow:
   - User generates a `HATCHET_CLIENT_TOKEN` from the Hatchet dashboard (Settings → API Tokens).
   - That token is set as an env var wherever the worker runs (local machine, GitHub Actions secret,
     K8s secret, etc.). The Hatchet SDK uses it to authenticate the persistent gRPC connection.
   - SaifCTL's only job is to document that `saifctl worker start` requires these two env vars:
     ```
     HATCHET_CLIENT_TOKEN=<from hatchet dashboard>
     HATCHET_SERVER_URL=<their hatchet instance>
     ```
   - Token scoping (per-team, per-project capabilities) is managed inside the Hatchet dashboard,
     not by SaifCTL.

5. **Leash telemetry forwarding:** ✓ Clarified against **strongdm/leash** source (main branch,
   shallow clone). There is **no** `webhook` string anywhere in the repository — **Leash does not
   ship a configurable audit webhook** today.
   - **Control UI (`leashd`)** exposes `internal/leashd/runtime.go:startFrontend()`:
     - `GET/WS /api` — `WebSocketHub.HandleWebSocket` — live event stream to the embedded SPA (same
       messages the UI sees; protocol is internal to Leash, not a supported public export API).
     - `/api/policies/*` — Cedar policy CRUD for the UI.
     - `/suggest`, `/healthz`, static SPA assets.
   - **File log:** `LEASH_LOG` (e.g. `LEASH_LOG=/log/events.log` from `internal/runner/runner.go`
     when launching the leash manager container) — events are also written to that path on the
     mounted log volume (`-v ... logDir:/log`).
   - **Product telemetry** uses OpenTelemetry + Statsig (`internal/telemetry/`) — not a
     user-defined audit export.
     **Implication for SaifCTL:** Forwarding fine-grained Leash events centrally means **we** build one
     of: (a) a small companion that tails `events.log` and maps lines → `AuditEvent` + optional
     `SAIFCTL_AUDIT_WEBHOOK_URL`; (b) an optional WebSocket client that speaks the same `/api` protocol
     as the SPA (brittle across Leash releases); or (c) an upstream feature request to StrongDM for
     a first-class export hook. Until then, orchestrator-emitted lifecycle events (item 3) are the
     reliable, version-stable path; Leash file/network audit is best-effort / integration-dependent.
