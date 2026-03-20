# Software Factory Infrastructure & Services (v0)

> **User-facing guide:** See [Environments and Infrastructure](../../services.md) for a readable guide to configuring and using ephemeral services, app/agent containers, and Docker Compose.

This document captures the architectural reasoning and final configuration schema for how SAIFAC handles environment infrastructure, mock services, and sandboxing across both the "Coding" (Agent) phase and the "Staging" (Testing) phase.

## The Challenge: The "Blast Radius" & Environment Sprawl

When an AI agent writes and executes code, it needs access to databases, Redis instances, or external APIs to run its unit tests. When SAIFAC runs Black Box validation, the staging app needs access to those same types of services.

If we don't manage these environments strictly, we encounter two enterprise fears:

1. **The Blast Radius:** The agent accidentally drops a real staging database or corrupts an integration environment.
2. **Environment Sprawl (The "containers" override mess):** If every feature's `tests.json` has to define its own Redis or Postgres container, we end up with hundreds of disconnected, unmaintainable container definitions scattered across the repo.

## The Solution: Centralized "Macro-Orchestration"

To solve this, SAIFAC acts as a **Macro-Orchestrator**.

Instead of inventing our own proprietary JSON schema for spinning up containers, we delegate to industry-standard Infrastructure-as-Code (IaC) tools that enterprise Platform Teams already use: **Docker Compose** (for local execution) and **Helm** (for Kubernetes execution).

The topology of the entire factory is defined strictly in the global SAIFAC configuration. Feature-level `tests.json` files **do not** define containers; they simply inherit the global platform environment provided to them.

### `config.ts` (The Environment Registry)

We use a TypeScript/JavaScript configuration file to allow dynamic execution based on environment variables (e.g., `SAIF_ENV=kubernetes`). The configuration explicitly separates the `coding` environment (where the agent lives) from the `staging` environment (where the black box tests run against the built app).

The `provisioner` field at the root of the environment block acts as a discriminated union, dictating whether SAIFAC should use Docker (with optional Compose integration) or Helm mechanics.

```typescript
// config.ts
import { defineConfig } from '@saifac/core';

const isK8s = process.env.SAIF_ENV === 'kubernetes';

export default defineConfig({
  project: 'my-enterprise-app',

  environments: {
    // ---------------------------------------------------------
    // 1. The Coding Phase (Where the agent writes code)
    // ---------------------------------------------------------
    coding: isK8s
      ? {
          provisioner: 'helm',
          chart: './k8s/charts/saifac-mocks',
          // SAIFAC dynamically creates a Kubernetes Namespace for the run
          namespacePrefix: 'saifac-run',
          agentEnvironment: {
            // SAIFAC creates a temporary ConfigMap using native Helm templating
            DATABASE_URL: 'postgres://user:pass@{{ .Release.Name }}-postgres-db:5432/db',
          },
        }
      : {
          provisioner: 'docker',
          file: './docker/docker-compose.dev.yml',
          agentEnvironment: {
            // SAIFAC injects this into the Agent container. Docker internal DNS resolves 'postgres-db'.
            DATABASE_URL: 'postgres://user:pass@postgres-db:5432/db',
          },
        },

    // ---------------------------------------------------------
    // 2. The Staging Phase (Where Black Box tests execute)
    // ---------------------------------------------------------
    staging: isK8s
      ? {
          provisioner: 'helm',
          chart: './k8s/charts/saifac-staging',
          namespacePrefix: 'saifac-run',
          appEnvironment: {
            DATABASE_URL: 'postgres://user:pass@{{ .Release.Name }}-postgres-db:5432/db',
          },
        }
      : {
          provisioner: 'docker',
          file: './docker/docker-compose.staging.yml',
          appEnvironment: {
            DATABASE_URL: 'postgres://user:pass@postgres-db:5432/db',
          },
        },
  },
});
```

### Feature-Specific Configuration: `tests.json`

Because all infrastructure is centralized in `config.ts`, the feature-specific test files are drastically simplified. The `containers` block is entirely removed.

`tests.json` is strictly for defining the **test execution commands** and **test cases**.

```json
// saifac/features/add-avatar/tests/tests.json
{
  "testCases": [
    {
      "id": "upload_avatar_success",
      "description": "User should be able to upload a valid PNG avatar",
      "command": "npm run test:e2e -- -g 'upload_avatar_success'"
    }
  ]
}
```

## Architectural Rationale & Edge Cases

### 1. Why not define "containers" natively in SAIFAC's JSON?

If we forced users to define containers via a custom JSON array (`[{ image: 'postgres', port: 5432 }]`), they would lose the ecosystem benefits of standard IaC tools.
Enterprise environments require volume mounts, healthchecks, `depends_on` sequencing, and complex networks. Docker Compose and Helm already solve these problems. SAIFAC's job is not to be a worse version of Docker Compose; SAIFAC's job is to orchestrate the Agent _around_ those tools.

### 2. Network Isolation & Concurrency

If two developers run `saifac run` simultaneously (or CI runs 10 parallel features), they cannot share the same database.

**In Docker Compose:** SAIFAC does not parse the Compose file to create networks. It relies entirely on the Compose **Project Name** (`-p` flag).
When SAIFAC executes `docker-compose -p saifac-run-123 -f file.yml up -d`, Compose automatically generates an isolated network named `saifac-run-123_default`. SAIFAC then launches the Agent container and pushes it into that specific network, ensuring zero port collisions and total isolation.

**In Kubernetes (Helm):** SAIFAC creates a dedicated **Namespace** (e.g., `saifac-run-123`). It executes `helm install mocks ./chart -n saifac-run-123` and deploys the Agent Pod into that same namespace.

### 3. The `agentEnvironment` Injection Challenge

The AI Agent is spun up by SAIFAC _dynamically_; it is not defined inside the user's `docker-compose.yml` or Helm chart. Therefore, SAIFAC must inject the environment variables (like `DATABASE_URL`) so the Agent knows how to talk to the mocks.

However, Docker Compose uses static hostnames (`db`), while Helm charts often use dynamic hostnames based on the release name (`saifac-run-123-db`).

To solve this without building a proprietary templating engine in SAIFAC:

- **For Docker:** SAIFAC just injects the strings directly.
- **For Helm:** SAIFAC takes the raw string defined in `config.ts` (which includes standard Helm `{{ }}` syntax), drops it into a temporary `ConfigMap.yaml`, and lets Helm's native Go-templating engine compile it during the `helm install` step.

### 4. Future Extensibility

By elevating the `provisioner` field to the top of the environment block, we use Discriminated Unions in TypeScript. This explicitly declares the orchestration intent. If an enterprise wants to use `podman-compose`, `terraform`, or `pulumi` in the future, we simply add a new string to the union and write a new macro-adapter in the SAIFAC core, without breaking the configuration schema.

### 5. Edge Cases & Implementation "Gotchas"

As we implement this macro-orchestrator approach, there are a few critical edge cases we must explicitly handle or guard against in the SAIFAC CLI logic:

#### The Docker Compose "Host Port Collision" Trap

Because SAIFAC uses Compose Project Names (`-p`) to achieve concurrency, Docker will spin up multiple isolated networks. However, if the user's `docker-compose.yml` explicitly binds a service to a host port (e.g., `ports: ["5432:5432"]`), the _second_ concurrent SAIFAC run will immediately crash because the host's port `5432` is already taken by the first run.
**Mitigation:**

- The Agent container does not need host-mapped ports because it runs _inside_ the Docker network.
- We must strongly document that `docker-compose` files provided to SAIFAC should avoid host-port bindings.
- Ideally, the SAIFAC orchestrator should parse the YAML before running `up -d` and throw a warning (or strip the bindings) if `ports` arrays are detected.

#### The "Shadow" Environment Files (.env priority)

In many frameworks (Next.js, Django, Rails), overriding configuration via raw shell environment variables (`agentEnvironment`) can sometimes be ignored if the framework aggressively prefers `.env.local` files present in the workspace.
**Mitigation:** SAIFAC may need to dynamically generate a `.env.saifac` file inside the agent's workspace and explicitly pass it to the testing commands (e.g., `dotenv -e .env.saifac -- npm run test`), or instruct the user to ensure their test runners respect shell variables over `.env` files.

#### Missing Compose Networks

If a user writes a `docker-compose.yml` but explicitly defines custom networks (e.g., `networks: [ backend-net, frontend-net ]`), Docker Compose will not put services on the default bridge network.
**Mitigation:** SAIFAC handles this elegantly. It first programmatically creates a single "God Network" (`saifac-net-<runId>`). After running `docker compose up`, SAIFAC iterates through every service spawned by Compose and forcefully attaches them to this God Network (`docker network connect`). SAIFAC then boots the Agent onto the God Network, giving it complete visibility into the mock topology regardless of how complex the user's YAML networking was.

#### Kubernetes Readiness

SAIFAC is architecturally ready for Kubernetes. The config schema supports `provisioner: 'helm'`, the discriminated-union design separates Docker vs Helm intent, and the `Provisioner` interface allows a drop-in `HelmProvisioner` without schema changes. Only the runtime adapter (the code that executes `helm install` and manages K8s namespaces) remains to be implemented.
