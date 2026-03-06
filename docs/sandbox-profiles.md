# Sandbox Profiles

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

Run `feat:run` to start the AI coding agent. `--profile python-uv` means we'll install dependencies with `uv` at the beginning:

```bash
pnpm agents feat:run my-feature --profile python-uv
```

## Available profiles

| Profile ID           | Display name                 |
| -------------------- | ---------------------------- |
| `node-npm`           | Node.js + npm                |
| `node-pnpm`          | Node.js + pnpm               |
| `node-pnpm-python`   | Node.js + pnpm + Python *(default)* |
| `node-yarn`          | Node.js + Yarn               |
| `node-yarn-python`   | Node.js + Yarn + Python      |
| `node-bun`           | Node.js + Bun                |
| `node-bun-python`    | Node.js + Bun + Python       |
| `python-pip`         | Python + pip                 |
| `python-pip-node`    | Python + pip + Node.js       |
| `python-poetry`      | Python + Poetry              |
| `python-poetry-node` | Python + Poetry + Node.js    |
| `python-uv`          | Python + uv                   |
| `python-uv-node`     | Python + uv + Node.js        |
| `python-conda`       | Python + Conda                |
| `python-conda-node`  | Python + Conda + Node.js     |
| `go`                 | Go                           |
| `go-node`            | Go + Node.js                 |
| `go-python`          | Go + Python                  |
| `go-node-python`     | Go + Node.js + Python        |
| `rust`               | Rust                         |
| `rust-node`          | Rust + Node.js               |
| `rust-python`        | Rust + Python                |
| `rust-node-python`   | Rust + Node.js + Python      |

Use `--profile <id>` to switch. See [commands](commands/README.md) for full command options.

## Overriding profiles

Sandbox profiles set defaults for the following five settings. You can override any of them individually:

| Override           | What it does                                      |
| ------------------ | ------------------------------------------------- |
| `--coder-image`    | Custom coder container image                      |
| `--stage-image`    | Custom staging container image                    |
| `--startup-script` | Custom script for installing workspace deps       |
| `--gate-script`    | Custom script for post-round validation           |
| `--stage-script`   | Custom script for starting the app in staging      |

Here is how you can supply custom installation script to a `node-pnpm-python` profile: 

```bash
pnpm agents feat:run \
  --profile node-pnpm-python \
  --startup-script ./my-install.sh \
  my-feature
```

If no built-in profile matches your project, omit `--profile` and supply the components directly:

```bash
pnpm agents feat:run \
  --coder-image my-coder:latest \
  --stage-image my-stage:latest \
  --startup-script ./my-install.sh \
  --gate-script ./my-check.sh \
  --stage-script ./my-start.sh \
  my-feature
```

See [openspec/specs/software-factory/swf-comp-d-sandbox.md](../openspec/specs/software-factory/swf-comp-d-sandbox.md) for the sandbox contract.
