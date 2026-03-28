# Docker Images

The factory uses several Docker images for the sandbox, coder agent, and test runners. **Pre-built images are published to GHCR** — use them directly; building locally is only needed for development or offline use.

## Images

| Image             | Default tag                             | Purpose                                                    |
| ----------------- | --------------------------------------- | ---------------------------------------------------------- |
| `saifctl-test-*`   | `saifctl-test-<profile>:latest`          | Test runner containers; one per language/framework profile |
| `saifctl-coder-*`  | `saifctl-coder-<sandbox-profile>:latest` | Built from `Dockerfile.coder` per profile (official Node, Python, golang, rust, or Miniconda base — not the Leash `coder` image). At run time SaifCTL copies orchestration scripts into the sandbox and bind-mounts them as `/saifctl`. |
| `saifctl-stage-*`  | `saifctl-stage-<sandbox-profile>:latest` | Lightweight staging container for that profile             |

### Test runner profiles

- `node-vitest`, `node-playwright`
- `python-pytest`, `python-playwright`
- `go-gotest`, `go-playwright`
- `rust-rusttest`, `rust-playwright`

## Local build

```bash
# Build default test runner only (node-vitest)
pnpm docker build test

# Build one profile
pnpm docker build test --test-profile python-pytest

# Build all test runner images
pnpm docker build test --all

# Skip images that already exist locally (same flag on test / coder / stage)
pnpm docker build test --all --skip-existing
pnpm docker build coder --all --skip-existing
pnpm docker build stage --all --skip-existing

`--skip-existing` only checks whether the tag exists locally; it does **not** detect an outdated image after Dockerfile changes (remove the image or rebuild without the flag to refresh).

# Build coder and stage images (no separate coder-base step)
pnpm docker build coder
pnpm docker build stage

# Same order as CI (all test profiles + all sandbox profiles)
pnpm docker:build:all
```

## Publishing workflow

Workflow: `.github/workflows/publish-images.yml`

### Triggers

The workflow runs **only on**:

- **Push to a version tag** (`v*`, e.g. `v1.0.0`)
- **GitHub Release published**

It does **not** run on push to `main` or on pull requests.

### Behavior

1. **Validate** — Runs `pnpm run validate`. Publishing proceeds only if validation passes.
2. **Build** — Builds all images:
   - All test runner profiles (`pnpm docker build test --all`)
   - All coder and stage profile images
3. **Publish** — Pushes each `saifctl-*` image to GHCR.

### Published tags

- `ghcr.io/<owner>/<repo>/<image>:latest` — always pushed
- `ghcr.io/<owner>/<repo>/<image>:<version>` — pushed when triggered by a tag (e.g. `v1.0.0`)

### Auth

The workflow uses `secrets.GITHUB_TOKEN`; no extra secrets are required for public repositories.

## Using published images

**Registry:** `ghcr.io/JuroOravec/safe-ai-factory`

When `--test-image` or `--coder-image` is omitted, Docker pulls the default image from GHCR automatically when it is not present locally. To pin a release:

```bash
# Test runners (use :latest or :v1.0.0 to pin a release)
saifctl feat run --test-image ghcr.io/JuroOravec/safe-ai-factory/saifctl-test-node-vitest:latest
saifctl feat run --test-image ghcr.io/JuroOravec/safe-ai-factory/saifctl-test-python-pytest:v1.0.0

# Coder image (default sandbox profile is node-pnpm-python)
saifctl feat run --coder-image ghcr.io/JuroOravec/safe-ai-factory/saifctl-coder-node-pnpm-python:latest
```

## Custom coder images

Start from the same kind of base as a profile (`node:*-bookworm-slim`, `python:*-slim-bookworm`, `golang:*-bookworm`, a published `saifctl-coder-*` image, etc.), then add your agent and tooling:

```dockerfile
FROM node:25-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm @anthropic-ai/claude-code
```

```bash
docker build -t my-coder:latest .
saifctl feat run --coder-image my-coder:latest
```

SaifCTL still bind-mounts `/saifctl` (orchestration scripts) and `/workspace` at run time; your image does not need to bake `coder-start.sh`.

## Storage

For **public** repositories, GHCR storage and bandwidth are free and unlimited. For private repositories, limits apply (see GitHub docs).

## Docker daemon (host)

The orchestrator uses **dockerode**, which reads **`DOCKER_HOST`** (via [docker-modem](https://github.com/apocas/docker-modem)) instead of the Docker CLI’s context file. If you use **Colima** (or any setup where the socket is not `/var/run/docker.sock`), set `DOCKER_HOST` for example:

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
```

For symptoms and step-by-step setup, see [Troubleshooting](../troubleshooting.md).
