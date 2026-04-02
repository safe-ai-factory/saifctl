# CLI internals

How the `saifctl` command-line interface is built and how to reason about flags when changing or debugging it.

## Stack

- **[citty](https://github.com/unjs/citty)** — `defineCommand`, nested `subCommands`, and `runMain` drive parsing and dispatch.
- **Node** — citty ultimately uses `node:util` `parseArgs` for option parsing (with `strict: false`), then applies its own conventions on top.

The published binary is `saifctl` → `dist/cli.js`, built from `src/cli/index.ts` via **tsup** (`tsup.config.ts` entry `cli`). During development, `package.json` scripts often invoke **`tsx src/cli/commands/<command>.ts`** so a single subcommand tree can be run without going through the root `saifctl` binary.

## Command tree

`src/cli/index.ts` registers top-level commands: `init`, `feat` / `feature` (alias), `run`, `cache`, `doctor`. Deeper nesting lives under each file in `src/cli/commands/` (e.g. `run ls`, `run apply`, `feat run`).

Citty picks the **first argv token that does not start with `-`** as the subcommand name, then slices remaining args for the child command. Options can generally appear before or after the subcommand as long as the parser can still associate values with flags (e.g. `--project-dir /path`).

## Help

`-h` / `--help` walks to the innermost matching command and prints usage (options, positionals, subcommands). Nested help text uses each command’s `meta.name`; when two subcommand keys share the same handler object (e.g. `list` and `ls`), the **usage line may show the handler’s `meta.name`**, not necessarily the spelling you typed.

User-facing command reference: [`docs/commands/README.md`](../commands/README.md).

## Boolean flags and `--no-xxx`

Citty does **not** set `no-pretty: true` when the user passes `--no-pretty`. For a boolean defined as **`pretty`** with **`default: true`**, the negated flag is surfaced as **`pretty: false`** in the parsed `args` object (via Node’s `--no-<name>` handling).

When adding a new “turn off the default” switch:

1. Name the argument the **positive** form (`pretty`, `reviewer`, …).
2. Set **`default: true`** when the default behavior is “on”.
3. Document **`--no-<name>`** for users; in code, read **`args.<name> !== false`** (or equivalent) if you need to treat “unset” like “true”.

Do **not** define a separate `no-pretty` boolean and expect `--no-pretty` to set it to `true`; that pattern does not match citty’s behavior.

## Kebab-case, camelCase, and `args`

CLI flags use **kebab-case** (`--project-dir`). Citty’s parsed `args` proxy resolves **camelCase and kebab-case** accessors to the same underlying value, but the **canonical keys** in the object follow how each flag was registered in `defineCommand` (often kebab-case for multi-word options). Prefer the same key spelling as in `args` definitions when reading `args` in command handlers.

## Repeated flags vs comma-separated lists

String options are normally parsed as a **single string**. Repeating the same flag (e.g. `--discovery-mcp a=1 --discovery-mcp b=2`) is **not** a supported pattern for accumulating values: the parser typically keeps **one** value per flag (often the **last** occurrence), so earlier values are lost.

For multi-value options, saifctl consistently uses **one flag** and **comma-separated** segments, parsed in `src/cli/utils.ts` by **`parseCommaSeparatedOverrides`** and similar helpers:

```bash
--discovery-mcp a=1,b=2
```

| Area | Flag (examples) | Format |
| ---- | --------------- | ------ |
| Storage | `--storage` | Global and/or `runs=local`, `tasks=s3://…` (comma-separated parts; `key=value` only if the key matches `^\w+=`) |
| Models | `--model`, `--base-url` | `agent=model` or bare global, comma-separated |
| Agent env | `--agent-env`, `--agent-env-file` | Comma-separated `KEY=VAL` or paths |
| Discovery MCP | `--discovery-mcp` | `name=url` entries, comma-separated |

Because splitting is on **commas**, individual values usually **must not contain commas** (e.g. agent names in `--model` cannot include commas). URLs with query strings remain **bare** segments (not `key=value` keys) because only `\w+=` prefixes are treated as keyed parts — see comments on **`KEY_EQ_PATTERN`** in **`resolveStorageOverrides`** / **`parseCommaSeparatedOverrides`** (`src/cli/utils.ts`).

Some parsers can theoretically yield a **string array** for a repeated flag; a few call sites defensively flatten that, but **do not rely on repeated flags** — use commas.

## Positionals

Required positionals (e.g. `runId`, feature `name`) are declared with `type: 'positional'`. If a required positional is missing, citty throws **`CLIError`** with a message like `Missing required positional argument: RUNID`. Integration tests that mock `process.exit` should still expect throws for parse-time errors before the handler runs.

## Read vs resolve

Command code keeps **citty’s parsed `args`** separate from **final values** (paths, merged config, storage clients):

1. **Read** — thin helpers that return only what the user passed (e.g. `readProjectDirFromCli`, `readSaifctlDirFromCli`, `readStorageStringFromCli`, `readDiscoveryCliReads`, `readAgentEnvPairSegmentsFromCli`, `readAgentEnvFileRawFromCli`).
2. **Resolve / merge** — combine those reads with `cwd`, loaded **`SaifctlConfig`**, and defaults (`resolveCliProjectDir`, `resolveSaifctlDirRelative`, `resolveStorageOverrides`, `resolveRunStorage`, `resolveDiscoveryOptions`, `mergeAgentEnvFromReads`).
3. **Models / base URLs** — the CLI supplies a **delta** only: **`parseLlmOverridesCliDelta`** in `src/orchestrator/options.ts`. The full stack is **`mergeLlmOverridesLayers(llmOverridesFromSaifctlConfig(config), artifact?, cliDelta)`** (config → optional stored-run artifact → CLI).

Comma-separated flag bodies are still tokenized by **`parseCommaSeparatedOverrides`** in `utils.ts`.

## Further reading

- `src/cli/utils.ts` — reads, resolves, discovery, agent-env merge, and comma parsing; storage merge is **`resolveStorageOverrides`** (raw string from **`readStorageStringFromCli`**).
- `src/orchestrator/options.ts` — **`parseLlmOverridesCliDelta`**, **`mergeLlmOverridesLayers`**, **`llmOverridesFromSaifctlConfig`**.
- `src/cli/args.ts` — reusable `defineCommand` arg fragments.
- Per-command files under `src/cli/commands/*.ts`.
