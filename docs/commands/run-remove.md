# saifac run rm

Delete a single stored run from run storage.

Removes the run artifact for the given run ID. Exits with an error if the run is not found or storage is disabled.

## Usage

```bash
saifac run rm <runId> [options]
```

## Arguments

| Argument             | Alias | Type   | Description                                                                                   |
| -------------------- | ----- | ------ | --------------------------------------------------------------------------------------------- |
| `runId`              | —     | string | Run ID to delete (positional, required)                                                       |
| `--project-dir`      | —     | string | Project directory (default: current working directory)                                        |
| `--storage`          | —     | string | Run storage: `runs=local` \| `runs=none` \| `runs=file:///path` \| `runs=s3` (default: local) |
| `--sandbox-base-dir` | —     | string | Sandbox base directory (only used by other run subcommands)                                   |

## Examples

Delete a run by ID:

```bash
saifac run rm add-login-r1
```

Get run IDs from `saifac run ls`:

```bash
saifac run ls
saifac run rm add-login-r1
```

Use custom storage location:

```bash
saifac run rm add-login-r1 --storage runs=file:///tmp/my-runs
```

## See also

- [Runs](../runs.md) — Run storage, resumption, and overview
- [`run list`](run-list.md) — List stored runs (get run IDs)
- [`run clear`](run-clear.md) — Bulk delete runs
