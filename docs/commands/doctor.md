# saifac doctor

Run environment health checks before you implement or debug a feature.

Verifies that **Docker** is running and optionally that **Hatchet** is configured and reachable.
Use this after setting up a local Hatchet server or when `saifac feat run` fails with
infrastructure errors.

## Usage

```bash
saifac doctor
```

This command takes no arguments.

## What it checks

1. **Docker** — runs `docker info`. The factory’s sandboxes and containers require a running daemon.
2. **Hatchet (optional)** —
   - If `HATCHET_CLIENT_TOKEN` is unset, prints a warning that saifac is running in **local (in-process) mode**. This is not a failure.
   - If the token is set, initializes the Hatchet SDK (`getHatchetClient()`). Success means the client was created for `HATCHET_SERVER_URL` (default `localhost:7077`). Connection failures surface as SDK errors in the output.

The process exits with code **1** only when a **hard** check fails (Docker down, or Hatchet token set but client initialization throws). Missing Hatchet token alone exits **0**.

## Examples

Basic check from your project root:

```bash
saifac doctor
```

Typical success output when Hatchet is not configured:

```text
saifac doctor

  ✔  Docker is running
  ⚠  HATCHET_CLIENT_TOKEN is not set — saifac will run in local (in-process) mode.
         To enable Hatchet durability + dashboard, see: docs/hatchet.md

All checks passed.
```

Typical success output with Hatchet env vars set:

```text
saifac doctor

  ✔  Docker is running
  ✔  HATCHET_CLIENT_TOKEN is set
  ✔  Hatchet client initialized (server: localhost:7077)

All checks passed.
```

## Environment variables

| Variable               | Required | Description                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------- |
| `HATCHET_CLIENT_TOKEN` | no       | If set, doctor attempts to build a Hatchet client. If unset, local mode only. |
| `HATCHET_SERVER_URL`   | no       | gRPC address for Hatchet (default `localhost:7077`). Shown in success output. |

See [Environment variables](../env-vars.md) and [Hatchet integration](../hatchet.md) for full setup.

## Notes

- **Hatchet is optional.** A missing token is intentional for users who do not use the distributed/durable path.
- **CLI warnings** mention `docs/hatchet.md` as a path hint; the canonical copy in this repo is [../hatchet.md](../hatchet.md).
