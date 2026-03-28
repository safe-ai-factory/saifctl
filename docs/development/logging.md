# Logging architecture

This document describes how saifctl produces terminal output, the decisions
behind each layer, and the rules to follow when adding new log statements.

---

## Overview

saifctl uses two distinct output paths:

| Path                                                      | What it carries                                                                                            | How it works                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Structured logger** (`consola`)                         | Application-level messages — progress, warnings, errors, debug info produced by saifctl's own code          | Level-filtered; respects `--verbose`, `CONSOLA_LEVEL`, `DEBUG` |
| **Raw stream forwarding** (`process.stdout/stderr.write`) | Byte-for-byte output from external processes — Docker container logs, LLM thought tokens, agent tool calls | Not filtered; always printed immediately                       |

These two paths are kept intentionally separate.

---

## Structured logger (consola)

### Why consola

`console.*` is ubiquitous but offers no level filtering, no structured context,
and no clean way to silence noisy output. Python's `logging` module is a better model:
callers emit at a level, and the handler decides what reaches the terminal.

[consola](https://github.com/unjs/consola) fills that gap cleanly:

- Level-based filtering (`fatal` → `error` → `warn` → `info` → `verbose` →
  `debug` → `trace`)
- Environment-variable control (`CONSOLA_LEVEL`, `DEBUG`) with no code changes
- TTY-aware reporters: fancy ANSI output in a real terminal, plain text
  everywhere else
- Lightweight; no transports to configure for a CLI use-case

### Shared instance

All application code imports from the central module:

```ts
import { logger } from '../logger.js'; // or the correct relative path
// also exported as `consola` for drop-in compatibility
import { consola } from '../logger.js';
```

**Do not** import directly from the `consola` package in application code:

```ts
// ❌ wrong — bypasses shared tag, level, and future reporter config
import { consola } from 'consola';
```

The central module lives at `src/logger.ts`. It:

1. Creates a `ConsolaInstance` with `tag: 'saifctl'` so every message is
   visually attributed.
2. Captures the baseline log level (set by `CONSOLA_LEVEL` / `DEBUG` at
   startup) so that `setVerboseLogging(false)` restores it rather than
   hard-coding `info`.
3. Exports `setVerboseLogging(verbose: boolean)` for CLI flag wiring.

### Log levels in practice

| Level     | Numeric | When to use                                  |
| --------- | ------- | -------------------------------------------- |
| `fatal`   | 0       | Unrecoverable errors; process will exit      |
| `error`   | 1       | Recoverable errors the user must see         |
| `warn`    | 2       | Something unexpected but non-fatal           |
| `info`    | 3       | Normal progress messages (default visible)   |
| `verbose` | 4       | Extra detail useful during routine debugging |
| `debug`   | 5       | Enabled by `--verbose` or `CONSOLA_LEVEL=5`  |
| `trace`   | 999     | Highly granular; only for deep diagnosis     |

Default runtime level is `info` (3). Users who want more detail have two
options:

- **One-off:** `saifctl feat run --verbose` — sets level to `debug` for that
  process.
- **Persistent:** `CONSOLA_LEVEL=5` in `.env` or the shell.

### Environment variables

| Variable        | Effect                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `CONSOLA_LEVEL` | Sets the numeric minimum level. Takes precedence over `DEBUG`.                                 |
| `DEBUG`         | If set (any non-empty value) and `CONSOLA_LEVEL` is absent, raises the level to `verbose` (4). |

consola reads both on instance creation; saifctl doesn't need to handle them
manually.

### VS Code extension

The extension host is not a TTY. Importing the standard `consola` package
there would render ANSI escape codes as raw characters in the Output panel.
The extension therefore imports from `consola/basic`, which always uses the
plain-text reporter regardless of environment.

The extension duplicate lives at `vscode-ext/src/saifctl-logger.ts` and mirrors
the same API (`logger`, `consola`, `setVerboseLogging`, `LogLevels`). The
verbose flag is controlled by the VS Code setting `saifctl.verbose` (in
**Settings → Extensions → Safe AI Factory**) and applied live via
`onDidChangeConfiguration`.

---

## Raw stream forwarding (`process.stdout/stderr.write`)

Several parts of the codebase write directly to stdout/stderr without going
through consola:

- `src/engines/docker/index.ts` — Docker container log lines and LLM
  thought tokens streamed in real time.
- `src/engines/docker/index.ts` — `[agent]` lines from container
  stdout/stderr; sidecar stderr.
- `src/orchestrator/loop.ts` — `[vague-specs-check]` think tokens from the
  specs-validation LLM call.

### Why not consola for these?

These writes are **stream forwarding**, not application logging:

1. **Unbuffered by design.** LLM tokens and Docker log lines must appear in the
   terminal the instant they arrive. consola buffers and formats messages before
   emitting them; that latency is acceptable for application messages but
   noticeable for live streaming.

2. **Not owned by saifctl.** The content originates from external processes
   (Docker, the LLM API). Running it through a logger would imply saifctl
   produced it, conflating two different sources.

3. **Not subject to level filtering.** These streams are the primary user-facing
   output of a long-running agent job. Hiding them at lower log levels would
   make the tool feel broken. If a user wants less noise, they can adjust the
   coding-agent profile or redirect stdio — not change saifctl's log level.

### Rule of thumb

> If the bytes originated outside this process, forward them raw.
> If saifctl itself generated the message, use `logger`.
