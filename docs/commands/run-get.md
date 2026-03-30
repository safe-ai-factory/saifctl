# saifctl run get

Print the **full** persisted Run object as JSON.

## Usage

```bash
saifctl run get <runId> [options]
```

## Arguments

| Argument        | Alias | Type    | Description                                                                                   |
| --------------- | ----- | ------- | --------------------------------------------------------------------------------------------- |
| `runId`         | —     | string  | Run ID to fetch (positional, required)                                                        |
| `--pretty`      | —     | boolean | Pretty-print JSON (default: true). Use `--no-pretty` for one line.                            |
| `--project-dir` | —     | string  | Project directory (default: current directory)                                                |
| `--saifctl-dir` | —     | string  | Saifctl config directory relative to project (default: `saifctl`)                             |
| `--storage`     | —     | string  | Run storage: `local` / `none` / `runs=…` (see [Runs](../runs.md)) |

## Examples

Pretty-printed full Run object (default):

```bash
saifctl run get abc12x
```

Compact JSON for piping:

```bash
saifctl run get abc12x --no-pretty | jq .runCommits | length
```

## See also

- [Runs](../runs.md) — Run object shape
- [`run info`](run-info.md) — Subset of a run object JSON
- [`run list`](run-list.md) — List runs
