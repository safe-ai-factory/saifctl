# Hatchet integration

By default the entire agentic run is executed **in-process** — no external services required.

Setting `HATCHET_CLIENT_TOKEN` opts into the Hatchet orchestrator, which adds:

- **Durability** — runs survive process crashes and can be resumed from where they left off.
- **Local dashboard** — `http://localhost:8888` shows step graphs, logs, and retry history.
- **Foundation for distributed workers** — same config points at Hatchet Cloud or a self-hosted
  cluster when you're ready.

When the token is absent the entire agentic run is executed in-process. If part of the workflow fails, the entire run stops.

## Quick start

```sh
# 1. Install the Hatchet CLI
npm install -g @hatchet-dev/cli

# 2. Start a local Hatchet server (requires Docker)
hatchet server start

# 3. Copy the generated API token printed in the output above, then export it:
export HATCHET_CLIENT_TOKEN=<token>
export HATCHET_SERVER_URL=localhost:7077

# 4. Run as normal — now with durability + dashboard
saifctl feat run -n my-feature

# Open http://localhost:8888 to watch the run in real time.
```

Run `saifctl doctor` at any time to verify connectivity:

```sh
saifctl doctor
#   ✔  Docker is running
#   ✔  HATCHET_CLIENT_TOKEN is set
#   ✔  Hatchet client initialized (server: localhost:7077)
#   All checks passed.
```

## Environment variables

| Variable               | Required | Description                                                   |
| ---------------------- | -------- | ------------------------------------------------------------- |
| `HATCHET_CLIENT_TOKEN` | Optional | API token from the Hatchet dashboard. Enables the Hatchet path. |
| `HATCHET_SERVER_URL`   | Optional | gRPC address of the Hatchet server. Defaults to `localhost:7077`. |

See [Environment variables](env-vars.md) for the full variable reference.

## How it works

When `HATCHET_CLIENT_TOKEN` is set, `saifctl feat run` submits the run to a
**Hatchet workflow** instead of driving the loop directly.
The workflow mirrors the same phases:

```
feat-run (parent workflow)
  ├─ provision-sandbox    — rsync sandbox, once per run
  ├─ convergence-loop     — iterates up to maxRuns times
  │    Each iteration spawns a child workflow:
  │    feat-run-iteration
  │      ├─ run-agent          — 60-min timeout; coder + gate + reviewer
  │      ├─ run-tests          — staging + test suite (raw result)
  │      └─ vague-specs-check  — optional LLM ambiguity pass → sanitizedHint
  └─ apply-patch          — commits, pushes, opens PR (success path only)
```

If the process is killed mid-run, Hatchet re-queues the interrupted step on
the next `saifctl feat run` invocation with the same run ID (resume support).
