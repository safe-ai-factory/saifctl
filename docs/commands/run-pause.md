# saifctl run pause

Pause a **running** Run. Resumable. Keeps file changes and Docker services. Use [`run resume`](run-resume.md) to continue.

## Usage

```bash
saifctl run pause <runId> [options]
```

## Arguments

| Argument        | Alias | Type   | Description                                                                                      |
| --------------- | ----- | ------ | ------------------------------------------------------------------------------------------------ |
| `runId`         | —     | string | Run ID to pause (positional, required).                         |
| `--project-dir` | —     | string | Project root (default: current dir).                                               |
| `--saifctl-dir` | —     | string | Saifctl config folder (default: `saifctl`).                                                      |
| `--storage`     | —     | string | Where saved runs live (`local`, `file://…`, `s3`, etc.). See [Runs](../runs.md).                 |
| `--timeout`     | —     | int    | Seconds to wait for the run to pause. Default: **60**. |

Pause does not take agent, engine, or sandbox flags.

## Examples

Pause a run whose ID you copied from the terminal or from `run list`:

```bash
saifctl run pause biehp82
```

Wait up to two minutes for the orchestrator to finish pausing:

```bash
saifctl run pause biehp82 --timeout 120
```

Custom storage location:

```bash
saifctl run pause biehp82 --storage runs=file:///tmp/my-runs
```

## Notes

- Only **`running`** runs can be paused; otherwise the CLI errors (`RunCannotPauseError`).

- Pausing stops the agent mid-work. Any agent's **changes are committed** and saved with the Run.

- If run storage is disabled, the CLI errors: `Run storage is disabled (--storage none). Cannot pause a stored run.`

## See also

- [Run lifecycle](../guides/run-lifecycle.md) — How pause / resume / start / test / apply fit together
- [`run resume`](run-resume.md) — Continue a paused Run
- [`run start`](run-start.md) — Continue failed or interrupted Run
- [Runs](../runs.md) — Artifact fields and storage backends
- [`run list`](run-list.md) — List run IDs and statuses
