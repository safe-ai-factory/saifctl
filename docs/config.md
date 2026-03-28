# Configuration

You can store default options in `saifctl/config.*` so you don't have to pass them via CLI every time.

## File location

Config is loaded from `saifctl/config.*` using [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig).

```
project-root/
├── saifctl/
│   ├── config.json
│   └── features/
│       └── add-login/
│           └── ...
├── src/
└── package.json
```

Supported formats:

- `config.json`
- `config.yaml` / `config.yml`
- `config.js` / `config.cjs` / `config.mjs`
- `config.ts`

## Structure

Config has a top-level `defaults` object and an optional `environments` object. All fields are optional. CLI flags override config defaults.

```json
{
  "defaults": {
    "maxRuns": 5,
    "testRetries": 2,
    "resolveAmbiguity": "ai",
    "globalModel": "anthropic/claude-sonnet-4",
    "agentModels": {
      "coder": "anthropic/claude-sonnet-4",
      "tests-planner": "openai/gpt-4o"
    },
    "agentEnv": {
      "OPENAI_API_KEY": "sk-..."
    }
  },
  "environments": {
    "coding": {
      "engine": "docker",
      "file": "./docker/docker-compose.dev.yml",
      "agentEnvironment": {
        "DATABASE_URL": "postgres://user:pass@postgres-db:5432/db"
      }
    },
    "staging": {
      "engine": "docker",
      "file": "./docker/docker-compose.staging.yml",
      "app": {
        "sidecarPort": 8080,
        "sidecarPath": "/exec"
      },
      "appEnvironment": {
        "DATABASE_URL": "postgres://user:pass@postgres-db:5432/db"
      }
    }
  }
}
```

### The `environments` Block (Infra engines)

The `environments` block defines external service infrastructure (databases, queues, etc.) needed during the Coding phase and the Staging phase. SaifCTL delegates the orchestration of these services to infra engines (currently supporting `docker`).

- **`environments.coding`**: Services running while the agent writes code.
  - `agentEnvironment`: Environment variables injected directly into the agent container. These provide connection strings (like `DATABASE_URL`) to reach the services.
- **`environments.staging`**: Services running while the test runner validates the app.
  - `app`: Configuration for the main application under test (`sidecarPort`, `sidecarPath`, `baseUrl`, and an optional `build.dockerfile`).
  - `appEnvironment`: Environment variables injected into the staging application container to reach its services.

See [Environments and Infrastructure](services.md) for a user guide. See [Infrastructure engines](infra.md) for engine types, fields, and `--engine`.

## Supported fields

### Project

| Field            | Type   | Example                  | CLI equivalent       |
| ---------------- | ------ | ------------------------ | -------------------- |
| `project`        | string | `"my-app"`               | `-p` / `--project`   |
| `sandboxBaseDir` | string | `"/tmp/saifctl/sandboxes"` | `--sandbox-base-dir` |

### Run params

| Field              | Type                        | Example                   | CLI equivalent                            |
| ------------------ | --------------------------- | ------------------------- | ----------------------------------------- |
| `maxRuns`          | number                      | `5`                       | `--max-runs`                              |
| `testRetries`      | number                      | `2`                       | `--test-retries`                          |
| `resolveAmbiguity` | `"off" \| "prompt" \| "ai"` | `"ai"`                    | `--resolve-ambiguity`                     |
| `cedarPolicyPath`  | string                      | `"/path/to/policy.cedar"` | `--cedar`                                 |
| `coderImage`       | string                      | `"saifctl-coder-node-pnpm-python:latest"` (or GHCR path) | `--coder-image` (overrides profile default) |
| `gateRetries`      | number                      | `10`                      | `--gate-retries`                          |
| `push`             | string                      | `"origin"`                | `--push`                                  |
| `pr`               | boolean                     | `true`                    | `--pr`                                    |
| `gitProvider`      | string                      | `"github"`                | `--git-provider`                          |
| `agentEnv`         | object                      | `{"KEY": "value"}`        | `--agent-env` (single or comma-separated) |
| `agentSecretKeys`  | string array                | `["MY_TOKEN"]`            | Host env var **names** only; values never stored in config (see [`--agent-secret`](commands/feat-run.md)) |
| `agentSecretFiles` | string array                | `["./secrets/a.env", "./secrets/b.env"]` | Project-relative paths to `.env` files with `KEY=value` secret pairs — same format as `--agent-env-file` |
| `dangerousNoLeash` | boolean                     | `false`                   | `--dangerous-no-leash`                    |


### LLM config

| Field           | Type   | Example                        | CLI equivalent                 |
| --------------- | ------ | ------------------------------ | ------------------------------ |
| `globalModel`   | string | `"anthropic/claude-sonnet-4"`  | `--model`                      |
| `globalBaseUrl` | string | `"https://api.example.com/v1"` | `--base-url`                   |
| `agentModels`   | object | `{"coder": "..."}`             | `--model` (agent=model parts)  |
| `agentBaseUrls` | object | `{"coder": "..."}`             | `--base-url` (agent=url parts) |

### Discovery

| Field                 | Type   | Example                                    | CLI equivalent                 |
| --------------------- | ------ | ------------------------------------------ | ------------------------------ |
| `discoveryMcps`       | object | `{"schema": "http://internal-mcp/schema"}` | `--discovery-mcp name=url,...` |
| `discoveryTools`      | string | `"./scripts/discovery-tools.ts"`           | `--discovery-tool path`        |
| `discoveryPrompt`     | string | `"Always check the Jira ticket..."`        | `--discovery-prompt`           |
| `discoveryPromptFile` | string | `"./docs/discovery-rules.md"`              | `--discovery-prompt-file`      |

Discovery runs only when `discoveryMcps` or `discoveryTools` is configured. Output: `discovery.md` in the feature directory.

### Profiles

| Field             | Type   | Example              | CLI equivalent   |
| ----------------- | ------ | -------------------- | ---------------- |
| `testProfile`     | string | `"node-vitest"`      | `--test-profile` |
| `agentProfile`    | string | `"openhands"`        | `--agent`        |
| `designerProfile` | string | `"shotgun"`          | `--designer`     |
| `indexerProfile`  | string | `"shotgun"`          | `--indexer`      |
| `sandboxProfile`  | string | `"node-pnpm-python"` | `--profile`      |

### Scripts

| Field              | Type   | Example                      | CLI equivalent         |
| ------------------ | ------ | ---------------------------- | ---------------------- |
| `testScript`       | string | `"./scripts/test.sh"`        | `--test-script`        |
| `testImage`        | string | `"saifctl-test-node:latest"` | `--test-image`         |
| `startupScript`    | string | `"./scripts/startup.sh"`     | `--startup-script`     |
| `stageScript`      | string | `"./scripts/stage.sh"`       | `--stage-script`       |
| `gateScript`       | string | `"./scripts/gate.sh"`        | `--gate-script`        |
| `agentScript`      | string | `"./scripts/agent.sh"`       | `--agent-script`       |
| `agentInstallScript` | string | `"./scripts/agent-install.sh"` | `--agent-install-script` |

### Storage

| Field           | Type   | Example                             | CLI equivalent        |
| --------------- | ------ | ----------------------------------- | --------------------- |
| `globalStorage` | string | `"local"` or `"s3://bucket/prefix"` | `--storage` (global)  |
| `storages`      | object | `{"runs":"local","tasks":"s3"}`     | `--storage` (key=val) |

## Precedence

1. **CLI flags** (highest)
2. **Config defaults**
3. **Built-in defaults** (lowest)
