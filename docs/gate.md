# Gate script

The **gate script** is a shell script that runs **inside the coder environment** after each agent round.

It is the fast, deterministic check layer: lint, format, typecheck, unit tests, etc.

Failures are fed back into the task so the agent can retry **before** the outer pipeline spends time on full test runs.

The gate is **not** a replacement for the Test Runner or hidden tests; it is a cheap guardrail feedback on the live workspace.

---

## How to use

The gate script (`--gate-script`) runs right after the coding agent has finished its work.
Gate script runs before the semantic reviewer.

Commands that use this loop include `saifac feat run` and `saifac run resume`.

```bash
saifac feat run -n <feature> --gate-script ./scripts/my-gate.sh
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
saifac feat run -n my-feature --gate-script ./scripts/my-gate.sh
```

### Config file

You can set all the settings above in the [config file](config.md) (e.g. `saifac/config.ts`).

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

## See also

- [Semantic Code Reviewer](reviewer.md) — reviewer step after the gate
- [Sandbox profiles](sandbox-profiles.md) — `--profile` and overriding `gate-script`
- [Configuration](config.md) — `defaults.gateScript` and `defaults.gateRetries`
