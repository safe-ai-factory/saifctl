# Cursor vs VS Code: Remote Containers extension compatibility

Reference notes that inform [`vscode-ext/src/inspectAttach.ts`](../src/inspectAttach.ts).

> **Last verified:** 2026-04-01
>
> - **MS Remote Containers:** `ms-vscode-remote.remote-containers` 0.452.0
> - **Cursor Remote Containers:** `anysphere.remote-containers` 1.0.32

---

## 1. Why this doc exists

The SaifCTL VS Code extension drives `inspect → attach` against whichever Dev Containers extension the user has installed — Microsoft's official one in stock VS Code, or Cursor's fork in Cursor.

The two extensions **share command IDs** but **diverge in argument shapes**. The headline divergence — Cursor's `attachToRunningContainer` requiring `{ containerId }` instead of a bare string — is the load-bearing reason `inspectAttach.ts` exists in its current shape (a single attach helper that branches on the host editor).

## 2. Headline finding — the "No container id found" quirk

In **`anysphere.remote-containers-1.0.32/dist/main.js`**, `remote-containers.attachToRunningContainer` and `remote-containers.attachToRunningContainerFromViewlet` register the **same** async handler (symbol `R` in the bundle).

Logic (paraphrased):

1. Run `docker info` (fail → error toast).
2. **`if (arg != null)`** — treat **any** non-null/undefined argument as a **viewlet event**:
   - Require **`arg.containerId`** to be a **string**.
   - If not → log "Attach to running container from viewlet got event of unexpected format" and show **"No container id found"**.
3. **`else`** — no argument → parse `docker ps` and show a **quick pick** of running containers.

So passing `executeCommand('remote-containers.attachToRunningContainer', 'my-container-name')` fails on Cursor: a bare string has no `.containerId`.

**Microsoft** (0.452.0 bundle) uses `typeof arg === 'string' ? arg : arg?.containerDesc?.Id` — a plain string is valid.

**Workaround for SaifCTL on Cursor:** call

```ts
executeCommand('remote-containers.attachToRunningContainer', { containerId: '<name-or-id>' });
```

(Docker inspect accepts name or id.) This is what `attachToRunningContainerCommandArg` in [`vscode-ext/src/inspectAttach.ts`](../src/inspectAttach.ts) implements; it branches on `vscode.env.appName` / `vscode.env.uriScheme` to pick the right argument shape.

## 3. Other notable differences

### Identity & packaging

|                          | Microsoft                                          | Cursor                          |
| ------------------------ | -------------------------------------------------- | ------------------------------- |
| **Publisher**            | `ms-vscode-remote`                                 | `anysphere`                     |
| **Version (verified)**   | 0.452.0                                            | 1.0.32                          |
| **Display name**         | Localized (`%displayName%`)                        | `Remote Containers`             |
| **Main entry**           | `./dist/extension/extension.js` (VSIX layout)      | `./dist/main.js`                |
| **Repository**           | `vscode-remote-release`                            | `getcursor/cursor`              |
| **`extensionKind`**      | `["ui"]`                                           | `["ui"]`                        |
| **`engines.vscode`**     | `^1.101.0`                                         | `^1.75.0`                       |
| **Extra API proposals**  | (see MS `package.json`)                            | includes `cursorTracing`        |

### Activation events

- **Microsoft only:** `onStartupFinished`, `onResolveRemoteAuthority:apple-container`
- **Cursor only:** `workspaceContains:.devcontainer/**/devcontainer.json`
- **Shared:** `dev-container`, `attached-container`, `k8s-container`, `extensionHost` resolve, devcontainer.json workspace contains.

### Commands (`contributes.commands`)

- **Microsoft:** 71 distinct command IDs.
- **Cursor:** 33 distinct command IDs (trimmed surface).

**Naming:** Microsoft uses IDs such as `remote-containers.openFolderInContainerInNewWindow`; Cursor exposes the same UX under `remote-containers.attachToContainerInNewWindow` (different command id, same idea as attach in new window).

**Only in Microsoft (examples):** install Docker / WSL, many explorer refresh helpers, `getHelp`, `installUserCLI`, Apple container attach, several RemoteHub / GitHub volume flows, `openFolderInContainerIn*` as separate ids, etc.

**Only in Cursor:** `killServerAndReload`, `reinstallServerAndReload`, `reopenFolderLocally`, `showLog` (Cursor-specific log command id), `triggerReconnect`.

Shared core set includes `attachToRunningContainer`, `attachToRunningContainerFromViewlet`, `attachToContainerInNewWindow`, `attachToContainerInCurrentWindow`, rebuild / reopen, clone-in-volume variants, etc.

### `jsonValidation`

- **Microsoft:** devcontainer **feature** schema via public spec URL (`devcontainer-feature.json`).
- **Cursor:** **bundled** `./resources/schemas/devContainer.schema.json`, `devContainerFeature.schema.json`, `attachContainer.schema.json`; validates `devcontainer.json` / `.devcontainer.json` locally; also validates attach config JSON under **both** `globalStorage/anysphere.remote-containers/...` and `globalStorage/ms-vscode-remote.remote-containers/...` (migration-friendly).

### Configuration (`contributes.configuration.properties`)

- **Microsoft:** many more `dev.containers.*` / `remote.containers.*` toggles (WSL execution, docker compose path, experimental Apple container, lockfile, log level, etc.).
- **Cursor:** smaller set (≈13 vs 43 top-level property keys); adds things like `dev.containers.enableSSHAgentForwarding`, `enableGPGAgentForwarding`, `kubectlPath`, `showReopenInContainerPrompt`; drops most of the MS-only experimental / WSL / compose path keys.

## 4. Reproducing the comparison

### 4.1 Export Cursor's Dev Containers `package.json`

1. In Cursor: **Extensions** → open **Dev Containers** (publisher Anysphere) → use **Open Extension Folder** / **Reveal in Finder** (wording varies by version), **or** find the folder manually.

2. Typical locations (pick what exists on your machine):

   - **macOS:** `~/.cursor/extensions/` — folder name like `anysphere.remote-containers-*` or `ms-vscode-remote.remote-containers-*` (Cursor sometimes keeps the Microsoft-style id with a forked build).
   - Copy that folder's **`package.json`** somewhere convenient (e.g. `/tmp/cursor-dev-containers.package.json`).

3. Optional: generate a slimmed-down "contributes" snapshot matching the MS shape:

   ```bash
   python3 - <<'PY'
   import json, pathlib
   src = pathlib.Path("/tmp/cursor-dev-containers.package.json")
   d = json.loads(src.read_text())
   c = d.get("contributes", {})
   out = {
       "name": d.get("name"),
       "version": d.get("version"),
       "publisher": d.get("publisher"),
       "activationEvents": d.get("activationEvents"),
       "commands": c.get("commands"),
       "menus": c.get("menus"),
       "views": c.get("views"),
       "viewsContainers": c.get("viewsContainers"),
       "jsonValidation": c.get("jsonValidation"),
       "configuration": c.get("configuration"),
       "keybindings": c.get("keybindings"),
       "customEditors": c.get("customEditors"),
       "authentication": c.get("authentication"),
   }
   pathlib.Path("/tmp/cursor-dev-containers.contributes.json").write_text(json.dumps(out, indent=2))
   PY
   ```

### 4.2 Refresh the Microsoft snapshot

Marketplace query (version / CDN URL may change over time):

```bash
curl -sS -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json;api-version=3.0-preview.1" \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"ms-vscode-remote.remote-containers"}],"pageNumber":1,"pageSize":1,"sortBy":0,"sortOrder":0}],"assetTypes":["Microsoft.VisualStudio.Services.VSIXPackage"],"flags":914}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['results'][0]['extensions'][0]['versions'][0]; print(r['version']); print([x['source'] for x in r['files'] if x.get('assetType')=='Microsoft.VisualStudio.Services.VSIXPackage'][0])"
```

Then download that VSIX URL, unzip `extension/package.json`, and you have the latest MS snapshot.

### 4.3 Compare MS vs Cursor

```bash
# Command count
python3 - <<'PY'
import json
def cmds(path):
    d = json.load(open(path))
    return sorted(
        (c["command"], c.get("title", "")) for c in (d.get("commands") or [])
    )
for label, path in [
    ("MS", "/tmp/ms-remote-containers-XXX.package.json"),
    ("Cursor", "/tmp/cursor-dev-containers.package.json"),
]:
    print(label, len(cmds(path)), "commands")
PY

# Full diff
diff -u /tmp/ms-remote-containers-XXX.package.json /tmp/cursor-dev-containers.package.json | less
```

For a tighter diff, compare only `commands` or only `jsonValidation` with `jq`.

## 5. When to revisit

Re-do this comparison when any of these triggers fire:

- **Cursor bumps `anysphere.remote-containers` past 1.0.32.** Their attach handler may align with Microsoft's signature again, in which case `attachToRunningContainerCommandArg` in `inspectAttach.ts` can be simplified or deleted.
- **Microsoft bumps `ms-vscode-remote.remote-containers` past 0.452.0** with a meaningful command-surface change (rare but worth a sanity check).
- **A user reports an attach failure** that the documented workaround doesn't cover (likely indicates the Cursor handler signature has shifted again).
- **Periodic drift check** — every ~6 months, even without a triggering event, re-fetch both manifests and diff. Cursor releases frequently; quiet drift between major versions is realistic.

When you do revisit, update the **Last verified** line in this doc's header and rev the version pins in §3.

## 6. Source snapshots

The raw JSON manifests that produced the analysis above are **not** checked into the repo. They're large (~150 KB), churn fast, and §4 documents how to re-fetch them. If you need them for a fresh diff, follow §4 — the curl + python recipes regenerate the same shape that this doc was originally built against.

If the marketplace API changes and the curl one-liner stops working, fall back to fetching VSIXs manually from the [VS Code Marketplace search](https://marketplace.visualstudio.com/search?term=remote-containers&target=VSCode).
