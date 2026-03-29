# saifctl run info

Print a stored run artifact as JSON for debugging or piping to tools.

## Usage

```bash
saifctl run info <runId> [options]
```

## Arguments

| Argument        | Alias | Type    | Description                                                                                   |
| --------------- | ----- | ------- | --------------------------------------------------------------------------------------------- |
| `runId`         | —     | string  | Run ID to show (positional, required)                                                         |
| `--pretty`      | —     | boolean | Pretty-print JSON (default: true). Citty maps `--no-pretty` to `pretty: false` (single line). |
| `--project-dir` | —     | string  | Project directory (default: current working directory)                                      |
| `--saifctl-dir`  | —     | string  | Saifctl config directory relative to project (default: `saifctl`)                             |
| `--storage`     | —     | string  | Run storage: `local` / `none` / `runs=…` (see [Runs](../runs.md)); default is local under project |

`--sandbox-base-dir` and other orchestration-only flags are not read by this subcommand; they have no effect here.

If run storage is disabled (e.g. `--storage none` or `runs=none`), or the run ID is not found, the command **errors** and exits non-zero (same class of behavior as [`run remove`](run-remove.md), unlike [`run list`](run-list.md) / [`run clear`](run-clear.md)).

## Examples

Pretty-printed JSON (default):

```bash
saifctl run info abc12x
```

Compact JSON for piping:

```bash
saifctl run info abc12x --no-pretty | jq .config.featureName
```

Example of the default **pretty-printed** output:

```json
{
  "runId": "abc12x",
  "baseCommitSha": "a1b2c3d",
  "runCommits": [
    { "message": "feat: add login form", "author": "openhands <agent@local>" },
    { "message": "fix: validation" }
  ],
  "specRef": "saifctl/features/add-login",
  "lastFeedback": "Test failure: expected 200, got 404",
  "config": {
    "featureName": "add-login",
    "gitProviderId": "github",
    "testProfileId": "vitest",
    "sandboxProfileId": "vitest",
    "projectDir": "/path/to/repo",
    "maxRuns": 5,
    "overrides": {},
    "saifctlDir": "saifctl",
    "projectName": "my-app",
    "testImage": "safe-ai-factory-test:latest",
    "resolveAmbiguity": "ai",
    "dangerousNoLeash": false,
    "cedarPolicyPath": "",
    "coderImage": "",
    "push": null,
    "pr": false,
    "gateRetries": 10,
    "reviewerEnabled": true,
    "agentEnv": {},
    "startupScriptFile": "sandbox-profiles/vitest/startup.sh",
    "gateScriptFile": "sandbox-profiles/vitest/gate.sh",
    "stageScriptFile": "sandbox-profiles/vitest/stage.sh",
    "testScriptFile": "test-profiles/vitest/test.sh",
    "agentInstallScriptFile": "agent-profiles/aider/agent-install.sh",
    "agentScriptFile": "agent-profiles/aider/agent.sh",
    "testRetries": 1,
    "stagingEnvironment": {
      "engine": "docker",
      "app": { "sidecarPort": 8080, "sidecarPath": "/exec" },
      "appEnvironment": {}
    },
    "codingEnvironment": { "engine": "docker" }
  },
  "status": "failed",
  "startedAt": "2026-03-21T10:00:00.000Z",
  "updatedAt": "2026-03-21T10:15:00.000Z"
}
```

## See also

- [Runs](../runs.md) — Run storage overview
- [`run list`](run-list.md) — List run IDs
- [`run remove`](run-remove.md) — Delete a stored run
- [`run clear`](run-clear.md) — Bulk delete runs
- [`run start`](run-start.md) — Resume a failed run
