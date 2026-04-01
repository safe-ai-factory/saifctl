# saifctl run resume

Continue a **paused** Run (paused by [`run pause`](run-pause.md)).

File changes and Docker services are reused. The coder container is recreated.

If they are missing, behaves the same as [`run start`](run-start.md).

## Usage

```bash
saifctl run resume <runId> [options]
```

## Requirements

- **Docker daemon** — Same as [`feat run`](feat-run.md).
- **LLM API keys** — Same as `feat run` / `run start`.

## Arguments

| Item | Behavior |
| ---- | -------- |
| **Positional `runId`** | Required. Run must be paused. |

Accepts all arguments from [`feat run`](feat-run.md), see that page for the full reference.

## Examples

Resume a paused run with default storage:

```bash
saifctl run resume biehp82
```

Resume with a different model:

```bash
saifctl run resume biehp82 --model anthropic/claude-4-6-sonnet-latest
```

Resume from S3-backed storage:

```bash
saifctl run resume biehp82 --storage runs=s3://my-bucket/runs
```

## Notes

- If the paused sandbox or Docker network are missing, **`run resume`** continues in the same way as [`run start`](run-start.md).

- **`run resume` vs `run start`:** Use **`resume`** only when the artifact says **`paused`**. Use **`start`** for **`failed`**, **`completed`** (re-run), or interrupted states without a pause.

- `run resume` MUST be run in the same git context as the original run. Otherwise the CLI fails with a clear error. Same expectation as [`run start`](run-start.md).

- If you set `--storage none` / `runs=none`, the CLI errors and exits non-zero (`Run storage is disabled (--storage none). Cannot start from a Run.`).

## See also

- [Run lifecycle](../guides/run-lifecycle.md) — feat run → pause → resume → test → apply
- [`run pause`](run-pause.md) — Pause a Run while it is running
- [`run start`](run-start.md) — Start a Run again
- [`run test`](run-test.md) — Re-test a Run
- [`run apply`](run-apply.md) — Apply commits to the host without running tests
- [Runs](../runs.md) — Run storage, resumption, and overview
