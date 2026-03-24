# saifac run resume

Resume a **failed** or **interrupted** Run from storage. Continues with the same flow as [`feat run`](feat-run.md).

Resumed run uses the same arguments as the original run.

## Usage

```bash
saifac run resume <runId> [options]
```

## Requirements

- **Docker daemon** — Same as [`feat run`](feat-run.md).
- **LLM API keys** — Same as `feat run`.

## How to obtain the run ID

The run ID is a random string, e.g. `biehp82`.

At the end of a run, the CLI prints a message like this:

```bash
Resume again with:
  saifac run resume <runId>
```

Alternatively, you can obtain the run ID by running `run list`.

```bash
saifac run list
```

The run ID is the first column in the output.

```
RUN_ID   FEATURE    STATUS  STARTED                    UPDATED
28k7anx  add-login  failed  2026-03-23T18:00:00.000Z   2026-03-23T19:12:12.419Z
5wjddk1  add-login  failed  2026-03-24T00:00:00.000Z   2026-03-24T01:49:10.982Z
```

## Flags overview

By default, `run resume` uses the same arguments as the original run.

To customize the run, you can use the same flags as [`feat run`](feat-run.md). Use that page as the full argument reference.

Resume-specific behavior:

| Item | Behavior |
| ---- | -------- |
| **Positional `runId`** | Required. Identifies the artifact in run storage. Feature and task context come from that artifact. |
| **`--name` / `-n`** | Not used, feature name comes from the stored run only. |

## Examples

Resume a failed run:

```bash
saifac run resume biehp82
```

Resume with a different model:

```bash
saifac run resume biehp82 --model anthropic/claude-3-5-sonnet-latest
```

Resume with a different agent:

```bash
saifac run resume biehp82 --agent aider
```

Custom storage location:

```bash
saifac run resume biehp82 --storage runs=file:///tmp/my-runs
```

## How it works

Each time you run `feat run`, a new [Run](../runs.md) is created and its metadata is stored in run storage. You can resume a run with `saifac run resume <runId>`.

`run resume` re-creates the exact copy of the workspace as it was when the coding agent stopped. It does this by creating a **temporary** git worktree that reconstructs your workspace at the time of the run started. And on top of it, `run resume` applies changes made by the agent during the run.

Once the workspace is reconstructed, `run resume` follows the same flow as `feat run`: the reconstructed workspace is copied into a container, and AI agent is run until it passes the checks and tests (or reaches the max runs).

## Notes

- `run resume` MUST be run in the same git context as the original run. Otherwise resume fails with a clear error.

   Example: If you ran `feat run` on a branch with latest commit `abc123`, then the commit `abc123` must still exist when you run `run resume`.
   
   We rely on git commits to faithfully reconstruct the workspace, while keeping the Run metadata light.

- The implementation does **not** reject when you resume a Run that has a `completed` status, but re-running a completed run is usually unnecessary. Consider [`run test`](run-test.md) to re-test the patch only.

- If you set `--storage none` / `runs=none`, the CLI errors and exits non-zero (`Run storage is disabled (--storage none). Cannot resume.`).

## See also

- [Runs](../runs.md) — Storage backends, portability, resumption overview
- [`feat run`](feat-run.md) — Full flag list and new-run behavior
- [`run list`](run-list.md) — List stored run IDs
- [`run info`](run-info.md) — View a saved run (summary JSON)
- [`run test`](run-test.md) — Re-test a stored patch without the coding agent
- [`run remove`](run-remove.md) — Delete a stored run
