# saifctl run rm

Delete a single Run from run storage.

**Alias:** `saifctl run remove` (same command).

Removes the run artifact for the given run ID.

## Usage

```bash
saifctl run rm <runId> [options]
# or: saifctl run remove <runId> [options]
```

## Arguments

| Argument        | Alias | Type   | Description                                                                                      |
| --------------- | ----- | ------ | ------------------------------------------------------------------------------------------------ |
| `runId`         | —     | string | Run ID to delete (positional, required)                                                          |
| `--project-dir` | —     | string | Project directory (default: current directory)                                         |
| `--saifctl-dir`  | —     | string | Saifctl config directory relative to project (default: `saifctl`)                                  |
| `--storage`     | —     | string | Run storage: `local` / `none` / `runs=…` (see [Runs](../runs.md)); default is local under project |

`--sandbox-base-dir` and other orchestration-only flags are not read by this subcommand; they have no effect here.

- If the run ID is **missing** from storage → **error** and non-zero exit.
- If run storage is **disabled** (e.g. `--storage none` or `runs=none`) → **error** and non-zero exit (unlike [`run list`](run-list.md) / [`run clear`](run-clear.md), which only log and exit 0).

## Examples

Delete a run by ID:

```bash
saifctl run rm add-login-r1
```

Get run IDs from `saifctl run list`:

```bash
saifctl run list
saifctl run remove add-login-r1
```

Use custom storage location:

```bash
saifctl run rm add-login-r1 --storage runs=file:///tmp/my-runs
```

## Notes

- Can't remove **`running` or `paused` Runs**. Stop them first with [`run stop`](run-stop.md).

## See also

- [Runs](../runs.md) — Run storage, resumption, and overview
- [`run list`](run-list.md) — List Runs (get run IDs)
- [`run info`](run-info.md) — View a saved run (summary JSON)
- [`run clear`](run-clear.md) — Bulk delete runs
