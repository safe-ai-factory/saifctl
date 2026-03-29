# Hatchet local runner

Internals for the **in-process Hatchet mock client**. This ensures a single code path for both local and remote Hatchet.

User-facing Hatchet setup (token, dashboard, env vars): [`docs/hatchet.md`](../hatchet.md).

## Problem

- **Duplicate code** — Initial implementation had separate Hatchet path and in-process loop path. This led to drift between the two.
- **Hard to test** — DAG ordering, `parentOutput`, `runChild`, and `onFailure` need automated coverage without Docker or `hatchet server start`.

## Solution

So instead, we re-implemented part of the Hatchet SDK. **It runs the workflows the same way as the Hatchet server, but all running in-process.**

Whether we use one or the other depends on the `HATCHET_CLIENT_TOKEN` environment variable.

## Not implemented (vs real Hatchet)

Persistence, retries, distributed workers, dashboard, server-side scheduling — anything that assumes an external engine. Failures are surfaced synchronously in-process.

## Files

| Path | Role |
| ---- | ---- |
| `src/hatchet/utils/local.ts` | Runner + `HatchetLike`, `WorkflowDeclaration`, `LocalContext` |
| `src/hatchet/utils/local.test.ts` | DAG, children, failures, `onFailure`, abort, etc. |
| `src/hatchet/client.ts` | `getHatchetClient()`, `_resetHatchetClient()` (tests) |
| `src/hatchet/workflows/feat-run.workflow.ts` | Production workflow; uses `getHatchetClient()` for declarations |
