# saifac run ls

List stored runs from run storage.

Shows persisted run artifacts (e.g. in `.saifac/runs/`). Use filters to narrow by status or task. If storage is disabled (`--storage runs=none`), the command reports that and exits.

## Usage

```bash
saifac run ls [options]
```

## Arguments

| Argument             | Alias | Type   | Description                                                                                   |
| -------------------- | ----- | ------ | --------------------------------------------------------------------------------------------- |
| `--status`           | —     | string | Filter by status (`failed`, `completed`, etc.)                                                |
| `--task`             | —     | string | Filter by task ID                                                                             |
| `--storage`          | —     | string | Run storage: `runs=local` \| `runs=none` \| `runs=file:///path` \| `runs=s3` (default: local) |
| `--project-dir`      | —     | string | Project directory (default: current working directory)                                        |
| `--sandbox-base-dir` | —     | string | Sandbox base directory (only used by other run subcommands)                                   |

## Examples

List all stored runs:

```bash
saifac run ls
```

List only failed runs:

```bash
saifac run ls --status failed
```

List runs for a specific task:

```bash
saifac run ls --task abc-123
```

Use custom storage location:

```bash
saifac run ls --storage runs=file:///tmp/my-runs
```

## Output

Runs are printed as a table: a header row (`RUN ID`, `FEATURE`, `STATUS`, `UPDATED`) plus one aligned row per run. Column widths grow with the longest value in each column.

### Example: several runs

```text
3 run(s):

  RUN ID   FEATURE        STATUS     UPDATED
  abc12x   feat-checkout  failed     2026-03-21T14:02:00.000Z
  def45y   feat-api       completed  2026-03-20T09:15:30.000Z
  ghi78z   feat-api       failed     2026-03-19T18:00:00.000Z
```

### Example: no runs (or empty storage)

```text
No stored runs found.
```

### Example: storage disabled

```text
Run storage is disabled (--storage none).
```

## See also

- [Runs](../runs.md) — Run storage, resumption, and overview
- [`run resume`](run-resume.md) — Resume a stored run
- [`run remove`](run-remove.md) — Delete a stored run
- [`run clear`](run-clear.md) — Bulk delete runs
