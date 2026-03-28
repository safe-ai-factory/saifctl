# Gate script

The **gate script** is a shell script that runs **inside the coder environment** after each agent round.

It is the fast, deterministic check layer: lint, format, typecheck, unit tests, etc.

Failures are fed back into the task so the agent can retry **before** the outer pipeline spends time on full test runs.

The gate is **not** a replacement for the Test Runner or hidden tests; it is a cheap guardrail feedback on the live workspace.

---

## How to use

The gate script (`--gate-script`) runs right after the coding agent has finished its work.
Gate script runs before the semantic reviewer.

Commands that use this loop include `saifctl feat run` and `saifctl run start`.

```bash
saifctl feat run -n <feature> --gate-script ./scripts/my-gate.sh
```

Example gate script `my-gate.sh` (NodeJS):

```bash
#!/bin/bash
set -euo pipefail

npx eslint .
npx tsc --noEmit
npm run test
```

When the gate script fails, the output of the script is appended to the AI agent's task. The agent runs again in the same inner loop.

- **Success:** exit code **0**.
- **Failure:** any non-zero exit code.

---

## Configuring the gate

### CLI

| Flag | Purpose |
| ---- | ------- |
| `--gate-script <path>` | Path to a shell script relative to your project (`--project-dir`) or absolute. Overrides the sandbox profile’s default `gate.sh`. |
| `--gate-retries <n>` | Maximum inner rounds (agent → gate → optional reviewer) per run. Default **10**. |
| `--no-reviewer` | Skip the semantic reviewer so only the gate (and agent) determine success for that step. |
| `--profile` | Chooses the default gate (and other scripts) from [Sandbox profiles](./sandbox-profiles.md) when `--gate-script` is omitted. |

Example:

```bash
saifctl feat run -n my-feature --gate-script ./scripts/my-gate.sh
```

### Config file

You can set all the settings above in the [config file](config.md) (e.g. `saifctl/config.ts`).

CLI flags **override** the config file values.

```ts
export default {
  defaults: {
    gateScript: "./scripts/my-gate.sh",
  },
};
```

---

## Best practices

- **Keep it deterministic** — no interactive prompts, avoid flaky network-only checks.
- Use **`set -euo pipefail`** (or equivalent) so failures propagate.
- Anything you print to stdout or stderr may appear in the agent’s next prompt when the gate fails, so make messages **actionable**.

---

## Installing dependencies

The gate runs in the **coder container**, so anything your script invokes (linters, compilers, CLIs) must exist in that environment. If the container is missing a tool, you can add it in three ways:

1. **Inline in `gate.sh`** 
   - For a **small** addition, run the install steps at the top of your gate script (the file you pass to `--gate-script`, or edits you keep in-repo). Prefer **idempotent** commands, because the gate may be executed many times per run.
2. **Override the agent install script** 
   - For a **one-time** setup when the coding environment comes up, use [`--agent-install-script`](commands/feat-run.md). See [Agents](development/agents.md) for how `agent-install.sh` fits the loop.
3. **Custom coder image** 
   - Build a Docker image with everything baked in and pass [`--coder-image`](commands/feat-run.md) (or [`defaults.coderImage`](config.md)). Best when installs are large, slow, or you want a fixed, reproducible toolchain for the whole team.

---

## See also

- [Semantic Code Reviewer](reviewer.md) — reviewer step after the gate
- [Sandbox profiles](sandbox-profiles.md) — `--profile` and overriding `gate-script`
- [Configuration](config.md) — `defaults.gateScript`, `defaults.gateRetries`, `agentInstallScript`, `coderImage`
- [`saifctl feat run`](commands/feat-run.md) — `--gate-script`, `--agent-install-script`, `--coder-image`
- [Agents](development/agents.md) — `agent-install.sh` and the agent loop
