# VS Code extension — development

## Prerequisites

- Node.js (LTS)
- [pnpm](https://pnpm.io/)
- [Visual Studio Code](https://code.visualstudio.com/) (or a VS Code–compatible editor such as Cursor)
- [`saifctl`](https://www.npmjs.com/package/@safe-ai-factory/saifctl) available either on `PATH` (global install) or via [local resolution](#cli-path-resolution) under your workspace (optional for UI-only work; see [Mock runs](#mock-runs))

## Install the extension from a `.vsix`

1. Build and package (from this directory):

   ```bash
   pnpm install
   pnpm run build
   pnpm run vsix
   ```

   This runs `vsce package` and writes a file like `safe-ai-factory-saifctl-0.0.1.vsix` in `vscode-ext/` (name includes publisher, package name, and version from `package.json`).

2. Install into VS Code:

   ```bash
   code --install-extension safe-ai-factory-saifctl-0.0.1.vsix
   ```

   Re-install after rebuilding (same file name if version unchanged):

   ```bash
   code --install-extension safe-ai-factory-saifctl-0.0.1.vsix --force
   ```

   On **Cursor**, if the CLI is available:

   ```bash
   cursor --install-extension safe-ai-factory-saifctl-0.0.1.vsix
   ```

   You can also install via the editor: **Extensions** → **…** menu → **Install from VSIX…** and pick the `.vsix` file.

## Run the extension in development (no install)

1. Open the `vscode-ext` folder in VS Code.
2. **Run and Debug** → launch **Run Extension** (or press F5).
3. A new **Extension Development Host** window opens with this extension loaded; changes require a reload or restart of that host after rebuilding.

Use `pnpm run watch:tsup` in a terminal for incremental builds while developing.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm run build` | Bundle `src/` → `dist/extension.js` (tsup) |
| `pnpm run vsix` | Package a `.vsix` for distribution |
| `pnpm run check-types` | TypeScript `--noEmit` |
| `pnpm run lint` | ESLint |
| `pnpm run compile` | check-types + lint + build |
| `pnpm run test` | Extension integration tests (Mocha; needs build + `compile-tests`) |
| `pnpm run test:unit` | Vitest unit tests |
| `pnpm run format` | Prettier write |

## Mock runs

To exercise the **Runs** tree without `saifctl` or `.saifctl/runs/` on disk, launch the Extension Development Host with:

```bash
SAIF_MOCK_RUNS=1 code /path/to/vscode-ext
```

(or set the same env var in your launch configuration for **Run Extension**).

## Publishing

Publishing to the Marketplace is done with `vsce publish` (requires publisher account and token). The `vsix` script is for local installs and CI artifacts; prepublish runs `pnpm run build` via `vscode:prepublish` in `package.json`.

## CLI path resolution

The extension decides how to invoke `saifctl` before every command (with a small per-directory cache). Logic lives in `src/binaryResolver.ts` and is wired through `SaifctlCliService` in `src/cliService.ts`.

### Order of resolution

1. **User override** — If **SaifCTL: Binary Path** (`saifctl.binaryPath`) is non-empty, that string is used as the command prefix exactly (after trim). Examples: full path to the binary, or `pnpm exec saifctl`. When empty (the default), auto-detection runs.

2. **Local `node_modules`**:
   - Walk **upward** from that `cwd` toward the filesystem root.
   - At each level, look for a local CLI shim: `node_modules/.bin/saifctl`. On Windows, `saifctl.cmd` and `saifctl.ps1` are tried before the extensionless name.
   - If a shim is found, choose how to run it:
     - **pnpm** — if `pnpm-lock.yaml` appears in the same upward walk (nearest match wins per walk), use `pnpm exec saifctl`.
     - **yarn** — if `yarn.lock` is found first that way, use `yarn saifctl`.
     - **npm** (or no lockfile) — use the **absolute path** to the shim under `node_modules/.bin/`.
   - Lockfile detection order at each directory is: `pnpm-lock.yaml`, then `yarn.lock`, then `package-lock.json` / `npm-shrinkwrap.json`.

3. **PATH fallback** — If step 2 does not apply (no local shim found on the walk from `cwd`), the extension runs plain `saifctl` and relies that `saifctl` is on the shell `PATH` (typical global install).

### Install detection

**“CLI installed”** (empty views, command guard) is checked with `saifctl version` using an **install cwd** chosen by `findBestInstallCwd`: it scans all workspace folders for `saifctl/` project roots and picks the first whose upward walk finds `node_modules/.bin/saifctl`, otherwise the first workspace folder. Individual commands still resolve the CLI per their own `cwd` (cached separately).

### Cache invalidation

The resolved prefix is cached per `cwd`. The extension clears the cache when:

- `saifctl.binaryPath` changes,
- a `saifctl/` directory is created or removed under the workspace, or
- `node_modules/.bin/saifctl*` changes (install/uninstall).

### Edge cases

- **Yarn Plug’n’Play** — If there is no `node_modules/.bin/saifctl`, local resolution does not trigger step 2’s invocation; set **Binary Path** to something like `yarn saifctl` or `yarn exec saifctl` if needed.

## Logging

Open **View → Output** → **SaifCTL**. Set the channel log level to **Trace** or **Debug** to see lower-level lines.

- **SaifCTL: Verbose** — when on, consola uses **trace** level and `binaryResolver` emits **debug** / **trace** lines (workspace list, each scanned directory, each `.bin` candidate tried).
- **Info** — resolved invocation (including cache hits), PATH fallback hints, install-check failures, `findBestInstallCwd` fallback when no local bin exists in any project root, and a settings snapshot whenever any `saifctl.*` configuration changes.
- **Trace** — file watcher events (`saifctl/features`, `saifctl` dir, `node_modules/.bin/saifctl*`), and **`Command … ← end`** lines when each registered command handler returns.
- **Debug** — **`Command … → start`** when a command handler is entered (with optional context such as feature name, `cwd`, or run id). Handlers are wrapped by **`loggedCommand()`**.
