# saifctl run list

List Runs from run storage.

**Alias:** `saifctl run ls` (same command).

Shows persisted run artifacts (e.g. in `.saifctl/runs/`). Use `--status` and `--task` to narrow results.

## Usage

```bash
saifctl run list [options]
# or: saifctl run ls [options]
```

## Arguments

| Argument        | Alias | Type   | Description                                                                                      |
| --------------- | ----- | ------ | ------------------------------------------------------------------------------------------------ |
| `--status`      | —     | string | Filter by status (`failed`, `completed`, etc.)                                                   |
| `--task`        | —     | string | Filter by task ID                                                                                |
| `--project-dir` | —     | string | Project directory (default: current directory)                                         |
| `--saifctl-dir`  | —     | string | Saifctl config directory relative to project (default: `saifctl`)                                  |
| `--storage`     | —     | string | Run storage: `local` / `none` / `runs=…` (see [Runs](../runs.md)); default is local under project |

`--sandbox-base-dir` and other orchestration-only flags are not read by this subcommand; they have no effect here.

If run storage is disabled (e.g. `--storage none` or `runs=none`), the command prints `Run storage is disabled (--storage none).` and **returns with exit code 0** — it does not treat that as an error (same behavior as [`run clear`](run-clear.md)).

## Examples

List all Runs:

```bash
saifctl run list
```

List only failed runs:

```bash
saifctl run ls --status failed
```

List runs for a specific task:

```bash
saifctl run list --task abc-123
```

Use custom storage location:

```bash
saifctl run list --storage runs=file:///tmp/my-runs
```

## Output

Rows are sorted by **UPDATED** (newest first); ties break on `RUN_ID`. Column widths grow with the longest value in each column.

### Example: several runs

```text
3 run(s):

  RUN_ID   FEATURE        STATUS     STARTED                    UPDATED
  abc12x   feat-checkout  failed     2026-03-21T12:00:00.000Z   2026-03-21T14:02:00.000Z
  def45y   feat-api       completed  2026-03-20T08:00:00.000Z   2026-03-20T09:15:30.000Z
  ghi78z   feat-api       failed     2026-03-19T17:00:00.000Z   2026-03-19T18:00:00.000Z
```

### Example: no runs (or empty storage)

```text
No Runs found.
```

### Example: storage disabled

```text
Run storage is disabled (--storage none).
```

(Exit code **0**.)

## See also

- [Runs](../runs.md) — Run storage, resumption, and overview
- [`run start`](run-start.md) — Resume a Run
- [`run remove`](run-remove.md) — Delete a Run
- [`run clear`](run-clear.md) — Bulk delete runs
