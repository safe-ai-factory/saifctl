# Software Factory: Docker Images & Container Management

## Overview

The Software Factory uses Docker to implement the **Mutual Verification** step of the convergence loop. Tests run in a **Test Runner** container that communicates with the **Staging container** (application under test) strictly over HTTP — no shared memory, no `docker exec`, no Docker socket. This document describes how we manage images and containers, and how to optimize the feedback loop.

---

## Summary: Pre-Built Images, Overrides & Opt-Out

Both the **Test Runner** and the **Staging Container** use pre-built or per-run images. The staging container runs `startup.sh` (same script as the coder) to install deps at runtime. This section is a quick reference; details follow.

### Test Runner

| What                   | How                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Default**            | Pre-built images from `ghcr.io/JuroOravec/safe-ai-factory` (e.g. `saifctl-test-node-vitest:latest`); pulled if not present locally                                          |
| **Override**           | `saifctl feat run --test-image ghcr.io/JuroOravec/safe-ai-factory/saifctl-test-python-pytest:latest`                                                                         |
| **Build manually**     | `pnpm docker build test` or `pnpm docker build test --all` — for development or offline use                                                                                 |
| **Custom image**       | `saifctl feat run --test-image my-test:v2` — bring any image that implements the Test Runner container contract (reads env vars, writes JUnit XML to `SAIFCTL_OUTPUT_FILE`). |
| **Custom test script** | `--test-script <path>` — override the default `test-default.sh` with a custom script; always bind-mounted at `/usr/local/bin/test.sh`, never baked into the image.          |

**Configuration:** CLI flags only — no environment variables.

### Staging Container

| What                  | How                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Default**           | **Build mode** — orchestrator builds an ephemeral image from the profile's `Dockerfile.coder` (same image as the coder container). Code is **mounted** at start; `startup.sh` installs deps. |
| **Custom Dockerfile** | `environments.staging.app.build.dockerfile` in `saifctl/config.ts` — use your own Dockerfile for non-standard sandboxes.                                                                      |

### Leash Coder Image (Agent Container)

| What               | How                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Default**        | `saifctl-coder-node-pnpm-python:latest` (or profile-specific) from GHCR; Docker pulls automatically when not local |
| **Build manually** | `pnpm docker build coder` — build from the sandbox profile's Dockerfile.coder                                      |
| **Override**       | `saifctl feat run --coder-image ghcr.io/JuroOravec/safe-ai-factory/saifctl-coder-node-pnpm-python:latest` (or the image for your `--profile`) |
| **Host coding**    | `saifctl feat run --engine local` — LocalEngine runs OpenHands on the host (no Leash coder container for coding) |

When Leash is enabled (default), the orchestrator runs the **Leash CLI** (`@strongdm/leash`) with `--image saifctl-coder-node-pnpm-python:latest ...` (or profile-specific tag), wrapping OpenHands in this image. The sandbox code dir is mounted at `/workspace`. See [swf-comp-d-leash.md](./swf-comp-d-leash.md) for details.

### Other Containers

- **Additional ephemeral** (postgres, redis, etc.): Supplied via engines (e.g. `DockerEngine`) configured in `saifctl/config.ts`.

---

## Architecture: Three-Container Black Box

| Container                 | Role                   | Image Source                                                                      | Purpose                                                                               |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Coder** (Leash)         | Coder agent            | `saifctl-coder-node-pnpm-python:latest` from sandbox profile's `Dockerfile.coder` | Runs OpenHands; agent writes code in sandbox; Cedar policy enforced                   |
| **Staging**               | Application under test | Ephemeral image built per-iteration                                               | Runs the codebase: web server or CLI wrapped in an HTTP Sidecar                       |
| **Test Runner**           | Test runner            | GHCR `saifctl-test-<profile>:latest` (or custom via `--test-image`)               | Runs tests against Staging container over HTTP; writes JUnit XML; graded by exit code |
| **Additional** (optional) | Ephemeral services     | Engines (e.g. `DockerEngine`)                                    | Postgres, Redis, etc. for digital-twin validation                                     |

All containers join a **dedicated bridge network** per run (e.g. `saifctl-net-{runId}`). Containers resolve each other by hostname. The Test Runner never mounts the Docker socket.

---

## Staging Container: Application Under Test

The Staging container runs the application under test. The workspace is **always mounted**; dependencies are installed at runtime via `startup.sh` (the same script the coder container uses).

### Execution Order

`staging-start.sh` runs inside the container in this order:

1. **startup.sh** (mounted at `/saifctl/startup.sh`) — installs workspace deps (e.g. `pnpm install`, `cargo fetch`). Same script as the coder container.
2. **Sidecar** — started in the background so the Test Runner can execute commands via HTTP.
3. **stage.sh** (mounted at `/saifctl/stage.sh`) — the profile's stage script; starts the app (e.g. `pnpm run start`) or keeps the container alive via `wait` for CLI-only. Set via `--profile` or `--stage-script`.

### Build Mode (default)

The orchestrator runs `docker build` to create a **runtime-only** image (node, pnpm, etc.). No code is baked in — the workspace is mounted at container start.

| Property      | Value                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| Image         | Ephemeral, tagged `saifctl-stage-{proj}-{feat}-img-{runId}`; removed after each iteration |
| Build context | Sandbox code directory — used only when the Dockerfile `COPY`s; default does not          |
| Code delivery | Bind-mount: `{codePath}:/workspace`                                                       |
| Deps          | Installed at runtime by `startup.sh`                                                      |

**Dockerfile resolution:**

| `saifctl/config.ts` `environments.staging.app` | Dockerfile used                                              |
| --------------------------------------------- | ------------------------------------------------------------ |
| `build` absent or `build.dockerfile` absent   | Sandbox profile's `Dockerfile.coder` (default: node-pnpm-python) |
| `build: { dockerfile: "path/to/Dockerfile" }` | Custom project Dockerfile                                    |

**Custom Dockerfile example** — for non-standard sandboxes, in `saifctl/config.ts`:

```typescript
environments: {
  staging: {
    engine: 'docker',
    file: './docker/docker-compose.staging.yml',
    app: {
      sidecarPort: 8080,
      sidecarPath: '/exec',
      build: { dockerfile: 'Dockerfile.custom' },
    },
  },
}
```

Use a custom Dockerfile when you need a specific base image, system packages, or a different runtime (Python, Go, Rust, etc.). See [Environments and Infrastructure](../services.md) for a user guide; [swf-services.md](./swf-services.md) for the full schema.

### Sidecar & Stage Script

- **Sidecar:** The orchestrator loads a pre-compiled Go binary (chosen by host architecture: `sidecar-linux-amd64` or `sidecar-linux-arm64`) and injects it as `/saifctl/sidecar` via `putArchive`. It is statically linked and requires no language runtime, so it works in any staging container (Node.js, Python, Go, Rust, etc.). Listens on `sidecarPort` (default 8080), path `sidecarPath` (default `/exec`).
- **stage.sh:** Set via `--profile` (default: node-pnpm-python) or `--stage-script`. The profile's stage script starts the app (e.g. `pnpm run start`) or keeps the container alive via `wait` for CLI-only.

### Naming

- Staging container: `saifctl-stage-{proj}-{feat}-{runId}`
- Ephemeral staging image (build mode): `saifctl-stage-{proj}-{feat}-img-{runId}`
- Test Runner container: `saifctl-test-{proj}-{runId}`
- Docker network: `saifctl-net-{proj}-{feat}-{runId}`
- `runId` is the short random suffix from the sandbox path (e.g. `abc1234` from `.../feat-abc1234`).
- `proj` is the project name (from `package.json` `"name"` or `--project`); `feat` is the feature name.
- All four resource types are scoped, so `pnpm docker clear` removes only this project's resources by default and `--all` removes everything across all projects.

---

## Test Runner Container

### Image Resolution (Precedence)

1. **CLI flag:** `--test-image <tag>`
2. **Default:** `saifctl-test-<profile>:latest` (profile from `--test-profile`)

The orchestrator validates the tag and passes it to Docker. Docker pulls the image from GHCR (or the configured registry) automatically when it is not present locally. No explicit pull or local-build step is performed.

Pre-built images are on GHCR. `pnpm docker build test` is only needed for local development or offline use.

### Test Runner Container Contract

The Orchestrator treats the Test Runner image as a black box. It only:

1. Bind-mounts test files and the test runner script (read-only), plus an output directory (read-write).
2. Passes a fixed set of environment variables.
3. Waits for the container to exit and reads the results file.

The **test runner script** (`test.sh`) is always bind-mounted at `/usr/local/bin/test.sh` — never baked into the image. By default it comes from `src/orchestrator/test-default.sh`; override via `--test-script <path>`.

**Environment variables provided by the Orchestrator:**

| Variable               | Description                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SAIFCTL_TARGET_URL`   | URL of the application under test. For CLI projects this is the sidecar URL; for web projects the app's base URL.        |
| `SAIFCTL_SIDECAR_URL`  | URL of the HTTP sidecar that wraps CLI command execution (always defined, even for web projects).                        |
| `SAIFCTL_FEATURE_NAME` | Name of the feature being tested (e.g. `greet-cmd`).                                                                     |
| `SAIFCTL_TESTS_DIR`    | Absolute path inside the container where test files are mounted. Default: `/tests`.                                      |
| `SAIFCTL_OUTPUT_FILE`  | Absolute path where the container **must write the JUnit XML results file**. Default: `/test-runner-output/results.xml`. |

**Volume mounts:**

| Host path                   | Container path           | Mode                        |
| --------------------------- | ------------------------ | --------------------------- |
| `{testsDir}/public/`        | `/tests/public/`         | `:ro`                       |
| `{testsDir}/hidden/`        | `/tests/hidden/`         | `:ro`                       |
| `{testsDir}/helpers.ts`     | `/tests/helpers.ts`      | `:ro`                       |
| `{testsDir}/infra.spec.ts`  | `/tests/infra.spec.ts`   | `:ro` (CLI containers only) |
| `{sandboxBasePath}/test.sh` | `/usr/local/bin/test.sh` | `:ro`                       |
| `{reportDir}/`              | `/test-runner-output/`   | `:rw`                       |

**Exit code contract:**

- `0` — all tests passed.
- non-zero — one or more tests failed (or runner error).

**Output file:** JUnit XML written to `SAIFCTL_OUTPUT_FILE`. If the runner crashes before producing output the file may be absent; the Orchestrator handles this gracefully.

### Pre-Built Test Runner Images

Pre-built images are published to `ghcr.io/JuroOravec/safe-ai-factory` for all supported profiles (node-vitest, node-playwright, python-pytest, python-playwright, go-gotest, go-playwright, rust-rusttest, rust-playwright). **`test.sh` is not baked into the image** — the Orchestrator always bind-mounts it at `/usr/local/bin/test.sh` from `src/orchestrator/test-default.sh` (or a custom script via `--test-script`).

- **Use:** `saifctl feat run --test-profile python-pytest` or `--test-image ghcr.io/JuroOravec/safe-ai-factory/saifctl-test-node-vitest:latest`
- **Build locally:** `pnpm docker build test` or `pnpm docker build test --all` — for development or offline (default images are on GHCR).

### Using a Custom Test Runner Image

You can bring your own Test Runner image (e.g. with Playwright, a different language runtime, or additional system packages). The Orchestrator will still bind-mount a script at `/usr/local/bin/test.sh` (from `test-default.sh` or `--test-script`). Your image can:

- **Use the mounted script:** Set `CMD ["/bin/sh", "/usr/local/bin/test.sh"]` — same as the default. The script reads env vars, runs vitest (or whatever your custom `--test-script` does), and writes JUnit XML.
- **Override per-run:** Pass `--test-script <path>` to use your own script content; it replaces the default for that run.
- **Ignore the mount:** Set a different `CMD` to run your own logic. You must still write JUnit XML to `$SAIFCTL_OUTPUT_FILE` and obey the exit code contract; otherwise the Orchestrator will not parse results correctly.

Pass `--test-image <your-image>` to `saifctl feat run` / `saifctl run test` / `saifctl feat design-fail2pass`.

### Startup Flow (Pre-Built)

1. **Resolve** the test runner image (Docker pulls from GHCR when not present locally).
2. **Write** `test.sh` to `{sandboxBasePath}/test.sh` (from `test-default.sh` or `--test-script`).
3. **Create** the container with the volume mounts (including `test.sh` at `/usr/local/bin/test.sh`) and env vars from the contract above.
4. **Start** the container — `test.sh` runs via CMD.
5. **Stream** container logs to the orchestrator terminal.
6. **Wait** for the container to exit; read the JUnit XML from `{reportDir}/results.xml`.

No `npm install` step. The container starts and runs tests in seconds.

### Naming

- Container name: `saifctl-test-{runId}`.
- In iterative modes, `runId` may include attempt suffix (e.g. `abc1234-r3`, `abc1234-a2`).

### Output

- **Verbose logs:** Streamed to container stdout (visible in orchestrator logs).
- **JUnit XML report:** Written by the container to `SAIFCTL_OUTPUT_FILE` (`/test-runner-output/results.xml`), which is bind-mounted to the sandbox root on the host. The Orchestrator reads this file after the container exits for per-suite analysis (e.g. `hasFeatureSuccessfullyFailed` to ignore infra health-check failures in fail2pass).

---

## Additional Containers (infra engines)

Engines (e.g. `DockerEngine`) supply ephemeral external services (postgres, redis, etc.) configured in `saifctl/config.ts` under `environments.staging`.

```typescript
// saifctl/config.ts
export default {
  environments: {
    staging: {
      engine: 'docker',
      // Specifies ephemeral services
      file: './docker-compose.staging.yml',
      app: {
        sidecarPort: 8080,
        sidecarPath: '/exec',
      },
      appEnvironment: {
        DATABASE_URL: 'postgres://user:pass@postgres-db:5432/db',
      },
    },
  },
};
```

- **Execution:** Managed by the tool specified in the config (e.g., `docker compose -p saifctl-<runId> up -d --wait`).
- **Network:** The engine attaches the created containers to the SaifCTL bridge network (`saifctl-net-{runId}`).
- **Naming & Hostname:** Docker compose handles container naming natively. The engine connects them to the SaifCTL network using their compose service name as the network alias, so other containers can reach them via standard hostnames (e.g. `postgres:5432`).
- **Startup:** Services are brought up by the engine before the Staging and Test Runner containers are created.
- **Teardown:** Services are torn down by the engine in the `finally` block or by the `CleanupRegistry` on SIGINT/SIGTERM (e.g., `docker compose down -v --remove-orphans`).

---

## Network Lifecycle

1. **Create:** `docker createNetwork({ Name: "saifctl-net-{runId}", Driver: "bridge" })`
2. **Use:** All containers use `NetworkMode: networkName`.
3. **Teardown:** After tests, `removeNetwork(networkName)`.
4. **SIGINT/SIGTERM:** The orchestrator registers all containers and networks in a `CleanupRegistry`. On signal, it tears down in reverse order (containers first, then network).

---

## Commands Reference

| Command                                     | Purpose                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `saifctl feat run`                           | Uses GHCR images for test runner and coder; pulls if not present locally                                |
| `saifctl feat design-fail2pass`              | Same behaviour                                                                                          |
| `saifctl run test <runId>`                 | Re-test a stored run’s patch (staging + test runner); no coding agent                                  |
| `pnpm docker build test [--all]`            | Build test runner image(s) locally (for development or offline use)                          |
| `pnpm docker build coder`                   | Build (or rebuild) the coder image from the sandbox profile's `Dockerfile.coder`             |
| `saifctl feat run --test-image my-test:v2`   | Use a custom test runner image                                                               |
| `saifctl feat run --engine local`             | LocalEngine: run OpenHands on host (coding phase)                                       |
| `saifctl feat run --coder-image my-coder:v2` | Use a custom coder image (also used for the staging container)                               |

---

## Security

- **No Docker socket in Test Runner:** The Test Runner never has access to `/var/run/docker.sock`. It communicates with the Staging container exclusively over HTTP.
- **Read-only test assets:** `tests.full.json` and `runner.spec.ts` are mounted `:ro`.
- **Ephemeral networks:** Each run gets a fresh network; no cross-run network reuse.
- **Cleanup on signal:** All resources are torn down on SIGINT/SIGTERM to avoid orphaned containers.
