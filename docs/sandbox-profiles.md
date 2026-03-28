# Sandbox profiles: Configure coding containers

By default the factory uses a Node.js + pnpm + Python sandbox.

You can pick and switch between language and package manager combinations using **sandbox profiles**.

You don't need to build anything. The factory ships pre-built coder and stage images for Node, Python, Go, and Rust.

## What is a sandbox profile?

A **sandbox profile** is a language and package manager combination (e.g. Node.js + pnpm, Python + Poetry, Rust) that the factory uses to configure:

1. **Coder container** — The container where the coding agent runs. E.g. `node-bun` installs Bun to the coder container.

2. **Staging container** — The container that runs your app during black-box testing.

3. **Startup script** — Runs once before the agent starts. Installs workspace deps: `pnpm install`, `poetry install`, `cargo fetch`, etc.

4. **Stage script** — Prepares the staging container for black box testing (e.g. `pnpm run start`). Runs after **Startup script**.

Use `--profile` to pick a profile. The default is `node-pnpm-python`.

## Example: Run agent on Python codebase

Run `saifctl feat run` to start the AI coding agent. `--profile python-uv` means we'll install dependencies with `uv` at the beginning:

```bash
saifctl feat run --profile python-uv
```

## Available profiles

| Profile ID           | Display name                        |
| -------------------- | ----------------------------------- |
| `node-npm`           | Node.js + npm                       |
| `node-pnpm`          | Node.js + pnpm                      |
| `node-pnpm-python`   | Node.js + pnpm + Python _(default)_ |
| `node-yarn`          | Node.js + Yarn                      |
| `node-yarn-python`   | Node.js + Yarn + Python             |
| `node-bun`           | Node.js + Bun                       |
| `node-bun-python`    | Node.js + Bun + Python              |
| `python-pip`         | Python + pip                        |
| `python-pip-node`    | Python + pip + Node.js              |
| `python-poetry`      | Python + Poetry                     |
| `python-poetry-node` | Python + Poetry + Node.js           |
| `python-uv`          | Python + uv                         |
| `python-uv-node`     | Python + uv + Node.js               |
| `python-conda`       | Python + Conda                      |
| `python-conda-node`  | Python + Conda + Node.js            |
| `go`                 | Go                                  |
| `go-node`            | Go + Node.js                        |
| `go-python`          | Go + Python                         |
| `go-node-python`     | Go + Node.js + Python               |
| `rust`               | Rust                                |
| `rust-node`          | Rust + Node.js                      |
| `rust-python`        | Rust + Python                       |
| `rust-node-python`   | Rust + Node.js + Python             |

Use `--profile <id>` to switch. See [commands](commands/README.md) for full command options.

## Overriding profiles

Sandbox profiles set defaults for the following four settings. You can override any of them individually:

| Override           | What it does                                  |
| ------------------ | --------------------------------------------- |
| `--coder-image`    | Custom image for both coder and staging containers |
| `--startup-script` | Custom script for installing workspace deps   |
| `--gate-script`    | Custom script for post-round validation       |
| `--stage-script`   | Custom script for starting the app in staging |

Here is how you can supply custom installation script to a `node-pnpm-python` profile:

```bash
saifctl feat run \
  --profile node-pnpm-python \
  --startup-script ./my-install.sh
```

If no built-in profile matches your project, omit `--profile` and supply the components directly:

```bash
saifctl feat run \
  --coder-image my-image:latest \
  --startup-script ./my-install.sh \
  --gate-script ./my-check.sh \
  --stage-script ./my-start.sh
```

---

## Commands by profile

Sandbox profiles dictate what commands are ran for installation or to start the app for black box testing.

Use the reference below to know what commands to expose.

For example, NodeJS web apps should define a `start` script, because the profile calls `npm run start`.

| Profile              | Startup (installation)                                                                           | Stage (app start)                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `go`                 | `go mod download` (if go.mod)                                                                    | Procfile `web:` → sh -c; else main.go → `go build` + exec; else cmd/ → `go build ./cmd/...`; else `wait` |
| `go-node`            | `go mod download` (if go.mod)                                                                    | Same as `go`                                                                                             |
| `go-node-python`     | `go mod download` (if go.mod)                                                                    | Same as `go`                                                                                             |
| `go-python`          | `go mod download` (if go.mod)                                                                    | Same as `go`                                                                                             |
| `node-npm`           | `npm ci` or `npm install` (fallback)                                                             | `npm run start` if package.json has start script; else `wait`                                            |
| `node-npm-python`    | `npm ci` or `npm install` (fallback)                                                             | Same as `node-npm`                                                                                       |
| `node-pnpm`          | `pnpm install --frozen-lockfile` or `pnpm install` (fallback)                                    | `pnpm run start` if package.json has start script; else `wait`                                           |
| `node-pnpm-python`   | `pnpm install --frozen-lockfile` or `pnpm install` (fallback)                                    | Same as `node-pnpm`                                                                                      |
| `node-yarn`          | `yarn install --frozen-lockfile` or `yarn install` (fallback)                                    | `yarn run start` if package.json has start script; else `wait`                                           |
| `node-yarn-python`   | `yarn install --frozen-lockfile` or `yarn install` (fallback)                                    | Same as `node-yarn`                                                                                      |
| `node-bun`           | `bun install --frozen` or `bun install` (fallback)                                               | `bun run start` if package.json has start script; else `wait`                                            |
| `node-bun-python`    | `bun install --frozen` or `bun install` (fallback)                                               | Same as `node-bun`                                                                                       |
| `python-pip`         | `uv sync` (if uv + pyproject.toml) or `pip install -r requirements.txt` (conditional)            | Procfile `web:` → sh -c; else app.py/main.py → `python`; else `wait`                                     |
| `python-pip-node`    | Same as `python-pip`                                                                             | Same as `python-pip`                                                                                     |
| `python-poetry`      | `poetry install` (if pyproject.toml)                                                             | Procfile → sh -c; else app.py/main.py → `poetry run python` or `python`; else `wait`                     |
| `python-poetry-node` | Same as `python-poetry`                                                                          | Same as `python-poetry`                                                                                  |
| `python-uv`          | `uv sync` (if pyproject.toml) or `uv pip install -r requirements.txt` (conditional)              | Procfile → sh -c; else app.py/main.py → `uv run python` or `python`; else `wait`                         |
| `python-uv-node`     | Same as `python-uv`                                                                              | Same as `python-uv`                                                                                      |
| `python-conda`       | `conda env update -n base -f environment.yml` or `pip install -r requirements.txt` (conditional) | Procfile → sh -c; else app.py/main.py → `python`; else `wait`                                            |
| `python-conda-node`  | Same as `python-conda`                                                                           | Same as `python-conda`                                                                                   |
| `rust`               | `cargo fetch` (if Cargo.toml)                                                                    | Procfile `web:` → sh -c; else `cargo run --release`; else `wait`                                         |
| `rust-node`          | `cargo fetch` (if Cargo.toml)                                                                    | Same as `rust`                                                                                           |
| `rust-node-python`   | `cargo fetch` (if Cargo.toml)                                                                    | Same as `rust`                                                                                           |
| `rust-python`        | `cargo fetch` (if Cargo.toml)                                                                    | Same as `rust`                                                                                           |

## Notes

### Monorepos

**Built-in profiles do not support monorepos.** They assume a single project root: one `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` style layout, with startup, gate, and stage behavior tuned for that pattern.

If your repo is a monorepo (workspaces, multiple packages, tools like Turborepo or Nx, mixed roots, etc.), pick a profile only for the **base image and toolchain**, then supply your own scripts.
