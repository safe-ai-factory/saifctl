# Docker Images

The factory uses several Docker images for the sandbox, coder agent, and test runners. **Pre-built images are published to GHCR** — use them directly; building locally is only needed for development or offline use.

## Images

| Image                | Default tag                     | Purpose                                                    |
| -------------------- | ------------------------------- | ---------------------------------------------------------- |
| `factory-test-*`     | `factory-test-<profile>:latest` | Test runner containers; one per language/framework profile |
| `factory-coder-base` | `factory-coder-base:latest`     | Base for coder images; contains coder-start.sh only       |
| `factory-coder`      | `factory-coder-node-pnpm-python:latest`| Extends coder-base; adds OpenHands (default coder agent)   |
| `factory-stage`      | `factory-stage:latest`          | Stage/staging container image                              |

### Test runner profiles

- `ts-vitest`, `ts-playwright`
- `py-pytest`, `py-playwright`
- `go-gotest`, `go-playwright`
- `rs-rusttest`, `rs-playwright`

## Local build

```bash
# Build default test runner only (ts-vitest)
pnpm docker build test

# Build one profile
pnpm docker build test --test-profile py-pytest

# Build all test runner images
pnpm docker build test --all

# Build coder and stage images
pnpm docker build coder-base
pnpm docker build coder
pnpm docker build stage
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
   - Coder base, coder, and stage images
3. **Publish** — Pushes each `factory-*` image to GHCR.

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
pnpm agents feat:run --test-image ghcr.io/JuroOravec/safe-ai-factory/factory-test-ts-vitest:latest <feat-name>
pnpm agents feat:run --test-image ghcr.io/JuroOravec/safe-ai-factory/factory-test-py-pytest:v1.0.0 <feat-name>

# Coder image
pnpm agents feat:run --coder-image ghcr.io/JuroOravec/safe-ai-factory/factory-coder:latest <feat-name>
```

## Storage

For **public** repositories, GHCR storage and bandwidth are free and unlimited. For private repositories, limits apply (see GitHub docs).
