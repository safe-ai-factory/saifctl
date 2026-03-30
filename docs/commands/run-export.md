# saifctl run export

Export run's changes as a **single multi-patch diff file**.

Use this instead of [`run apply`](run-apply.md) when you ran with **`--include-dirty`**. This way, you can control how the uncommitted or untracked files should be handled.

## Usage

```bash
saifctl run export <runId> [options]
```

## Arguments

| Argument        | Alias | Type   | Description                                                                                                                                 |
| --------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`         | —     | string | Run ID to export (positional, required)                                                                                                     |
| `--output`      | `-o`  | string | Output patch file path (default: `./saifctl-<feature>-<runId>-<diffHash>.patch`) |
| `--project-dir` | —     | string | Project directory (default: current directory). Used to warn if `HEAD` differs from the run's `baseCommitSha`.                    |
| `--saifctl-dir`  | —     | string | Saifctl config directory relative to project (default: `saifctl`)                                                                             |
| `--storage`     | —     | string | Run storage: `local` / `none` / `runs=…` (see [Runs](../runs.md)); default is local under project                                          |

## Examples

Export with the default output path:

```bash
saifctl run export pwc2l1j
# Output: ./saifctl-my-feature-pwc2l1j-abc123.patch
```

Write to a chosen path:

```bash
saifctl run export pwc2l1j -o /tmp/my-feature.patch
```

Apply in your repo:

```bash
git apply --check saifctl-my-feature-pwc2l1j-abc123.patch
git apply saifctl-my-feature-pwc2l1j-abc123.patch
```

Stage the diff only (e.g. to review in the editor):

```bash
git apply --cached saifctl-my-feature-pwc2l1j-abc123.patch
# then commit, or: git restore --staged .
```

## Patch file anatomy

The patch file contains the diffs of all the commits made during the run.

It is a multi-patch diff file, with multiple `diff --git` blocks in sequence.

The diffs are in the same order as the commits in the run.

Example:

```text
diff --git a/src/index.js b/src/index.js
index 1234567..89abcdef 100644
--- a/src/index.js
+++ b/src/index.js
@@ -1,2 +1,3 @@
 unchanged line
+inserted line
 unchanged line
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..cfad022
--- /dev/null
+++ b/README.md
@@ -0,0 +1,7 @@
+# Dummy
+
+Placeholder for the documentation pipeline and project scaffold.
+
+## Purpose
+
+This file is a placeholder in the documentation pipeline. It acts as a scaffold until real content replaces it.
```

## Notes

- If the run has no commits, the command errors and exits non-zero.

- Patches that touch `.git/hooks/` are rejected (same guard as [`run apply`](run-apply.md) and host apply in the main loop).

- If run storage is disabled (`--storage none` / `runs=none`), the CLI errors and exits non-zero (`Run storage is disabled (--storage none). Cannot export a Run.`).

- If the Run is missing `featureName`, the CLI uses `unknown` in the default filename.

## See also

- [Runs](../runs.md) — Run storage, `runCommits`, `baseCommitSha`
- [`run apply`](run-apply.md) — Branch, optional push/PR
- [`run list`](run-list.md) — List run IDs
- [`feat run`](feat-run.md) — `--include-dirty` and `defaults.includeDirty`
