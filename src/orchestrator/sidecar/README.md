# The Sidecar: A Language-Agnostic HTTP-to-Shell Bridge

Every staging container in the factory runs a small HTTP server called the **sidecar**. It is the reason the test runner can execute commands inside a Python, Go, or Rust container without needing `docker exec`, the Docker socket, or any language-specific runtime installed in the test image.

This document explains what the sidecar does, why it is written in Go, how it gets into the container, how the right binary is chosen at runtime, and how to rebuild it when you need to.

---

## The problem it solves

The factory runs two containers side-by-side for every agent iteration:

- **Container A (staging)** — the application under test. Runs the code the AI agent just wrote: a Node.js server, a Python CLI, a Rust binary, whatever the project is.
- **Container B (test runner)** — a separate, sandboxed container that executes the black-box tests against Container A.

Container B needs to be able to run arbitrary shell commands *inside* Container A — things like `python cli.py --input foo`, `cargo run -- solve`, or `node dist/index.js`. This is how CLI-style tests work: they invoke the program and assert on stdout, exit code, and side effects.

The naive solution is `docker exec`. But `docker exec` requires access to the Docker socket (`/var/run/docker.sock`), which means Container B would have root-equivalent access to the entire host. That is a no-go for a sandboxed AI coding agent.

The sidecar solves this with a simple inversion: instead of the test runner reaching *out* to Docker, it reaches *in* to an HTTP server that is already running inside Container A. Container B sends a POST request with a command to run; the sidecar executes it and sends back the result. No Docker socket. No privileged access. Just HTTP over an isolated Docker bridge network.

```
Container B (test runner)
  POST http://staging:8080/exec
  { "cmd": "python", "args": ["cli.py", "--input", "foo"] }
       │
       │  Docker bridge network (isolated per run)
       ▼
Container A (staging)
  sidecar (port 8080)
  → runs: python cli.py --input foo
  → returns: { stdout, stderr, exitCode }
```

---

## The API

The sidecar exposes two endpoints.

### `GET /health`

Returns immediately with `{ "status": "ok" }`. The orchestrator polls this before handing control to the test runner, so it knows the sidecar is up and ready.

### `POST /exec`

Executes a command inside the container and returns the result.

**Request body:**

```json
{
  "cmd": "python",
  "args": ["-m", "pytest", "tests/"],
  "env": { "MY_VAR": "value" },
  "timeout": 30000
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `cmd` | string | yes | The executable to run |
| `args` | string[] | no | Arguments (default: `[]`) |
| `env` | object | no | Environment variable overrides (layered on top of the container's existing env) |
| `timeout` | number | no | Timeout in milliseconds. Default: 60000. Clamped to 1000–600000. |

**Response body:**

```json
{
  "stdout": "...",
  "stderr": "...",
  "exitCode": 0
}
```

The response always returns HTTP 200, even when the command exits non-zero. The exit code is carried in the JSON body. This keeps the test runner's HTTP client simple — a non-200 always means an infrastructure error (bad JSON, missing `cmd`, etc.), not a test failure.

---

## Why Go

The original sidecar was a TypeScript/Node.js file, transpiled at runtime with esbuild and injected into the container as a `.cjs` bundle. That worked perfectly — for Node.js containers. The moment you want to run the factory against a Python or Rust codebase, the staging image has neither Node.js nor npm. The esbuild bundle becomes a dead artifact.

Go solves this at the root. With `CGO_ENABLED=0`, Go compiles to a **statically-linked binary** — a single executable file with no shared library dependencies, no runtime, no interpreter. It runs on any Linux system, even a completely minimal distroless image with nothing else in it.

The comparison is stark:

| | Node.js CJS bundle | Go static binary |
|---|---|---|
| Requires Node.js in container | yes | no |
| Works in Python containers | no | yes |
| Works in Rust containers | no | yes |
| Works in Go containers | no | yes |
| Dependencies | Node.js runtime | none |
| Binary size | ~0 KB (but needs 50+ MB runtime) | ~5 MB |
| Cross-compilation | complex | trivial |

The sidecar uses only Go's standard library: `net/http`, `os/exec`, `encoding/json`, `context`. There are no third-party dependencies and no `go.sum` entries.

---

## Why two binaries

Docker containers always run Linux, regardless of the host OS. On a Mac, Docker Desktop runs a lightweight Linux VM underneath; on CI, you are already on Linux. But that Linux VM has to match the host machine's **CPU architecture**.

There are two architectures that matter in practice:

- **`linux/amd64`** (x86_64) — Intel and AMD processors. All cloud VMs that are not explicitly ARM-based. GitHub Actions' `ubuntu-latest` runners.
- **`linux/arm64`** (aarch64) — Apple Silicon (M1, M2, M3, M4). AWS Graviton instances. Some CI providers are starting to offer this.

A binary compiled for `amd64` will not run on `arm64`, and vice versa. So two binaries are required. They live at:

```
src/orchestrator/sidecar/out/sidecar-linux-amd64
src/orchestrator/sidecar/out/sidecar-linux-arm64
```

Both are committed to the repository. Users do not need Go installed to run the factory.

---

## How the right binary is chosen

The orchestrator runs on the **host machine** — it is the TypeScript process that orchestrates everything via the Docker API. At the point where the orchestrator prepares the staging container, it reads the appropriate binary based on the host's CPU architecture using Node's `os.arch()`:

```typescript
// src/orchestrator/docker/staging.ts
const hostArch = arch(); // 'arm64' on Apple Silicon, 'x64' on Intel/AMD
const binaryName = hostArch === 'arm64' ? 'sidecar-linux-arm64' : 'sidecar-linux-amd64';
```

This works because Docker always creates containers that match the host architecture by default. If you are on an M2 Mac, Docker runs `linux/arm64` containers; the `arm64` binary is the right one. On an Intel workstation or a GitHub Actions runner, Docker runs `linux/amd64` containers; the `amd64` binary is the right one.

The binary is read into memory as a `Buffer` — it never touches the filesystem again after that point.

---

## How and when the binary is injected into the container

The injection happens **between `createContainer` and `container.start()`**, before the container has run a single instruction. This is the window where the Docker daemon (running as root) can write files into the container's filesystem via `putArchive`, regardless of what user the container will eventually run as.

The orchestrator injects two files via `putArchive` (sidecar and staging-start.sh must be executable; bind mounts can lose the +x bit). stage.sh is mounted read-only instead — it's invoked via `sh /factory/stage.sh` so it need not be executable.

```
/factory/sidecar          ← injected via putArchive (Go binary, mode 0755)
/factory/staging-start.sh ← injected via putArchive (entrypoint script)
/factory/stage.sh         ← mounted from host (profile's startup script, e.g. pnpm run start)
```

The archive injection:

```typescript
const tarBuffer = createTarArchive([
  { filename: 'sidecar', content: SIDECAR_BINARY, mode: '0000755' },
  { filename: 'staging-start.sh', content: STAGING_START_SCRIPT, mode: '0000755' },
]);
await container.putArchive(tarBuffer, { path: '/factory' });
```

`SIDECAR_BINARY` is a `Buffer` loaded once at orchestrator startup — the raw bytes of the pre-compiled binary for the host's architecture.

---

## The startup sequence inside the container

Once `container.start()` is called, the container runs `/bin/sh /factory/staging-start.sh`. Here is exactly what happens, in order:

```
1. sh /factory/startup.sh
   Install workspace dependencies.
   Same script the coder container runs: pnpm install, pip install, cargo fetch, etc.
   Ensures the staging environment is identical to where the code was written.

2. /factory/sidecar &
   Start the sidecar in the background.
   It binds to 0.0.0.0:$FACTORY_SIDECAR_PORT immediately.

3. sh /factory/stage.sh
   Run the profile's staging script.
   For web apps: pnpm run start, uvicorn app:main, cargo run, etc.
   For CLI-only projects: wait (keeps the container alive).
```

Meanwhile, the orchestrator is polling `GET http://staging:$PORT/health` and will not hand control to the test runner until it gets a 200 back. Once it does, the sidecar is provably ready and all subsequent `POST /exec` calls will be served.

---

## How to rebuild the binaries

You need Go 1.23 or later. No other tools are required.

```bash
cd src/orchestrator/sidecar

# Linux x86_64 (Intel/AMD workstations, most cloud VMs, GitHub Actions)
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o out/sidecar-linux-amd64 .

# Linux ARM64 (Apple Silicon, AWS Graviton)
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o out/sidecar-linux-arm64 .
```

The `-s -w` flags strip the symbol table and DWARF debug info, reducing the binary size from ~8 MB to ~5 MB. The binaries are self-contained; there is nothing to install.

Commit both binaries after rebuilding. The repository intentionally tracks compiled binaries here because users should not need Go installed to run the factory.

---

## Configuration

The sidecar is configured entirely through environment variables, set by `staging-start.sh` before the process starts:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on |
| `SIDECAR_PATH` | `/exec` | HTTP path for the exec endpoint |
| `WORKSPACE` | `/workspace` | Working directory for all spawned commands |

These values come from the test catalog (`tests.json`) and are injected by the orchestrator as container environment variables (`FACTORY_SIDECAR_PORT`, `FACTORY_SIDECAR_PATH`).

---

## Security model

The sidecar is a deliberate capability boundary, not a security boundary. It intentionally executes arbitrary commands — that is its job. The security comes from the surrounding architecture:

- The sidecar listens on `0.0.0.0` but the container is on an **isolated Docker bridge network** created fresh for each run. Nothing outside the factory's containers can reach it.
- The test runner (Container B) can only communicate with Container A over this network, using the well-known hostname `staging`. It cannot reach the Docker socket, the host filesystem, or any external network that is not explicitly allowed.
- Container A itself has `--cap-drop ALL` and `--security-opt no-new-privileges`, limiting what the code under test can do even if it tries to escape.

The sidecar is the controlled channel through which test assertions flow inward. Everything else is walled off.
