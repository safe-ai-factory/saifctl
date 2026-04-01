# saifctl run stop

Stop a **`running`** or **`paused`** Run with full teardown. The Run becomes **`failed`**.

Use [`run start`](run-start.md) to start a Run from scratch.

Unlike [`run pause`](run-pause.md), stop does **not** preserve the sandbox or Docker network.

## Usage

```bash
saifctl run stop <runId> [options]
```

## Arguments

| Argument        | Alias | Type   | Description                                                                                      |
| --------------- | ----- | ------ | ------------------------------------------------------------------------------------------------ |
| `runId`         | —     | string | Run ID to stop (positional, required).                         |
| `--project-dir` | —     | string | Project root (default: current dir).                                               |
| `--saifctl-dir` | —     | string | Saifctl config folder (default: `saifctl`).                                                      |
| `--storage`     | —     | string | Where saved runs live (`local`, `file://…`, `s3`, etc.). See [Runs](../runs.md).                 |
| `--timeout`     | —     | int    | Seconds to wait for the run to finish shutting down. Default: **60**. |
| `--force`       | `-f`  | flag   | Do not wait: stop Docker and remove the saved workspace if possible. |

Stop does not take agent, engine, or sandbox flags.

## Examples

Stop a run whose ID you copied from the terminal or from `run list`:

```bash
saifctl run stop biehp82
```

Wait up to two minutes for the run to finish shutting down:

```bash
saifctl run stop biehp82 --timeout 120
```

Custom storage location:

```bash
saifctl run stop biehp82 --storage runs=file:///tmp/my-runs
```

If a run stays on **Stopping** (or otherwise looks stuck), stop it without waiting:

```bash
saifctl run stop biehp82 --force
```

## Notes

- Stopping a **`running`** Run stops the agent mid-work. Any agent's **changes are committed** and saved with the Run, then the sandbox is destroyed. Stopping a **`paused`** run tears down the paused sandbox only (no live agent).

- If run storage is disabled, the CLI errors: `Run storage is disabled (--storage none). Cannot stop a Run.`

## See also

- [Run lifecycle](../guides/run-lifecycle.md) — How pause / resume / start / test / apply fit together
- [`run pause`](run-pause.md) — Pause without tearing down the sandbox
- [`run start`](run-start.md) — Continue failed or interrupted Run
- [Runs](../runs.md) — Artifact fields and storage backends
- [`run list`](run-list.md) — List run IDs and statuses
