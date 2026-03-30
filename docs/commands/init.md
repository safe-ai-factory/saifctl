# saifctl init

Initialize Saifctl config and Shotgun indexer.

One-time setup: Scaffolds `saifctl/config.ts` (if no config exists), creates the `saifctl/` directory, configures Shotgun (optionally with Context7 for documentation lookup), and indexes the codebase for spec-driven workflows.

## Usage

```bash
saifctl init [options]
```

## Arguments

| Argument        | Alias | Type   | Description                                            |
| --------------- | ----- | ------ | ------------------------------------------------------ |
| `--project`     | `-p`  | string | Project name override (default: `package.json` "name") |
| `--saifctl-dir`  | —     | string | Path to saifctl directory (default: `saifctl`)           |
| `--project-dir` | —     | string | Project directory (default: current directory) |

## Examples

Basic init (uses `package.json` name as project):

```bash
saifctl init
```

Override project name:

```bash
saifctl init -p my-project
```

Use a custom saifctl directory:

```bash
saifctl init --saifctl-dir ./my-saifctl
```

Use a custom project directory (e.g. when running from a parent monorepo):

```bash
saifctl init --project-dir ./packages/my-app
```

## Environment variables

| Variable           | Required | Description                                                                                                      |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `SHOTGUN_PYTHON`   | no       | Path to the Python binary that has `shotgun-sh` installed (default: `python`). Example: `$(uv run which python)` |
| `CONTEXT7_API_KEY` | no       | API key for Context7 documentation lookup inside Shotgun. Configured once via `saifctl init`.                     |

## What it does

1. Scaffolds `saifctl/config.ts` (if no config exists).
2. Runs `python -m shotgun.main config init`
3. Optionally configures Context7 via `python -m shotgun.main config set-context7 --api-key <key>` (if CONTEXT7_API_KEY is set)
4. Indexes the codebase with `python -m shotgun.main codebase index . --name <project>`

## Generated config

When no config exists, `saifctl init` creates `saifctl/config.ts` with:

```typescript
import type { SaifctlConfig } from 'safe-ai-factory';

const config: SaifctlConfig = {
  defaults: {
    // project: 'my-app',
    // indexerProfile: 'shotgun',
  },
  environments: {
    coding: {
      provider: 'none',
      agentEnvironment: {},
    },
    staging: {
      provider: 'none',
      app: {
        sidecarPort: 8080,
        sidecarPath: '/exec',
        // baseUrl: 'http://staging:3000',
        // build: { dockerfile: './Dockerfile.staging' },
      },
      appEnvironment: {},
    },
  },
};

export default config;
```

Set `engine: 'docker'` and add a `file` when you need ephemeral services (databases, queues, etc.). See [Environments and Infrastructure](../services.md) for details.

## Notes

- **Custom Python path** - Use `SHOTGUN_PYTHON=$(uv run which python) saifctl init ...` if Python needs uv.
