# saifctl run list

List Runs from run storage.

**Alias:** `saifctl run ls` (same command).

Shows persisted run objects (e.g. in `.saifctl/runs/`). Use `--status` and `--task` to narrow results.

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
| `--format`      | —     | string | Output format: `table` (default) or `json` — machine-readable list for tooling |
| `--pretty`      | —     | boolean | When `--format json`: pretty-print JSON (default: true). Use `--no-pretty` for one line. |

`--sandbox-base-dir` and other orchestration-only flags are not read by this subcommand; they have no effect here.

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

Machine-readable list (JSON array), newest first — same sort as the table:

```bash
saifctl run list --format json --no-pretty
```

## Output

### Table format (default)

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

### JSON format (`--format json`)

Stdout is a JSON array of run objects, each with `runId`, `featureName`, `specRef`, `status`, `startedAt`, `updatedAt`, and `taskId` when present:

```json
[
  {
    "runId": "abc12x",
    "featureName": "feat-x",
    "status": "failed",
    "startedAt": "2026-03-21T10:00:00.000Z",
    "updatedAt": "2026-03-21T10:15:00.000Z",
  }
]
```

Pretty-printing is on by default; use `--no-pretty` for a single-line payload suitable for piping.

## See also

- [Runs](../runs.md) — Run storage, resumption, and overview
- [`run get`](run-get.md) — Full run object JSON
- [`run info`](run-info.md) — Subset of a run object JSON
- [`run start`](run-start.md) — Resume a Run
- [`run remove`](run-remove.md) — Delete a Run
- [`run clear`](run-clear.md) — Bulk delete runs
