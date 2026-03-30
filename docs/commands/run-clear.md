# saifctl run clear

Clear (bulk delete) Runs from run storage.

Removes run artifacts for every run that matches the filter.

**Without `--failed`**, all Runs are deleted (any status). **With `--failed`**, only runs whose stored `status` is `failed` are removed; completed runs are kept.

If run storage is disabled (e.g. `--storage none` or `runs=none`), the command prints `Run storage is disabled (--storage none).` and **returns with exit code 0** — it does not treat that as an error (same behavior as [`run list`](run-list.md)).

## Usage

```bash
saifctl run clear [options]
```

## Arguments

| Argument        | Alias | Type    | Description                                                                                      |
| --------------- | ----- | ------- | ------------------------------------------------------------------------------------------------ |
| `--failed`      | —     | boolean | Clear only runs with status `failed` (omit to clear **all** Runs)                       |
| `--project-dir` | —     | string  | Project directory (default: current directory)                                         |
| `--saifctl-dir`  | —     | string  | Saifctl config directory relative to project (default: `saifctl`)                                  |
| `--storage`     | —     | string  | Run storage: `local` / `none` / `runs=…` (see [Runs](../runs.md)); default is local under project |

`--sandbox-base-dir` and other orchestration-only flags are not read by this subcommand; they have no effect here.

## Examples

Clear all Runs:

```bash
saifctl run clear
```

Clear only failed runs:

```bash
saifctl run clear --failed
```

Use custom storage location:

```bash
saifctl run clear --storage runs=file:///tmp/my-runs
```

## Output

For each deleted run, one line:

```text
  removed <runId>
```

Then a summary (including when nothing was removed):

```text

Cleared N run(s).
```

If **N = 0**, there are no `removed` lines — only the summary.

## See also

- [Runs](../runs.md) — Run storage, resumption, and overview
- [`run list`](run-list.md) — List Runs
- [`run remove`](run-remove.md) — Delete a single run
