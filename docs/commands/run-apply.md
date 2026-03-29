# saifctl run apply

Apply Run's commits to your real git repository as a local branch, with optional **push** and **PR**.

Use this when tests already passed (or you accept the stored patch as-is) but **host apply failed** or was skipped.

## Usage

```bash
saifctl run apply <runId> [options]
```

## Requirements

- **LLM API keys** — (Optional) To generate a PR summary (`--pr`).

## Arguments

`run apply` accepts the same **push / PR / branch / storage / verbosity** flags as [`run test`](run-test.md) (see that page for the full table). It does **not** accept agent, gate, or test-runner flags — there is no sandbox or test phase.

| Argument         | Alias | Type   | Description                                                                 |
| ---------------- | ----- | ------ | --------------------------------------------------------------------------- |
| `runId`          | —     | string | Saved run id (required). Use `saifctl run list`.                             |
| `--branch`       | —     | string | Override the local branch name for host apply (default: `saifctl/<feature>-<runId>-<diffHash>` as in [How it works](#how-it-works)). |
| `--push`         | —     | string | Push target after apply (remote name, URL, or `owner/repo`).                |
| `--pr`           | —     | bool   | Open a PR after push (requires `--push` and provider token).                |
| `--git-provider` | —     | string | `github`, `gitlab`, `bitbucket`, `azure`, or `gitea` (default: `github`).   |
| `--project-dir`  | —     | string | Project root (default: current directory).                                  |
| `--saifctl-dir`   | —     | string | Saifctl config folder (default: `saifctl`).                                   |
| `--storage`      | —     | string | Run storage URI (must match where the run lives).                           |
| `--model`        | —     | string | LLM overrides (e.g. for PR summarizer when `--pr` is set).                 |
| `--base-url`     | —     | string | API base URL overrides (same rules as `--model`).                           |
| `--verbose`      | `-v`  | bool   | More detailed logs.                                                         |

## Examples

Create the branch locally (no push):

```bash
saifctl run apply pwc2l1j
```

Push upstream (GitHub, GitLab, etc.) and open a PR:

```bash
saifctl run apply pwc2l1j --push origin --pr
```

Force a specific branch name (e.g. after a collision):

```bash
saifctl run apply pwc2l1j --branch saifctl/my-feature-retry-2
```

## How it works

1. Loads the saved run for the ID you gave.
2. Rebuilds a **temporary copy** of your project exactly as that run left it (same approach as [`run start`](run-start.md), but no agent loop).
3. **Applies the patch to your real repo** on branch `saifctl/<feature>-<runId>-<diffHash>` (default, or `--branch`),
4. Optionally **pushes** and opens a **PR** (same flags as `feat run` / `run test`).

## Notes

- The default branch name is suffixed with a hash derived from the agent's changes.
  Two branches will conflict only if they have the same agent changes.

- This command **does not** change run `status` in storage or re-run tests. To verify the patch first, use [`run test`](run-test.md).

- Patches that touch `.git/hooks/` are rejected (same guard as host apply in the main loop).

- If you set `--storage none` / `runs=none`, the CLI errors and exits non-zero (`Run storage is disabled (--storage none). Cannot start from a stored run.`).

- `run start` MUST be run in the same git context as the original run. Otherwise resume fails with a clear error.

   Example: If you ran `feat run` on a branch with latest commit `abc123`, then the commit `abc123` must still exist when you run `run start`.
   
   We rely on git commits to faithfully reconstruct the workspace, while keeping the Run metadata light.

## See also

- [Guide: Run lifecycle](../guides/run-lifecycle.md) — When to use `run apply` vs `run test`
- [Runs](../runs.md) — Artifact fields (`runCommits`, `baseCommitSha`, `basePatchDiff`)
- [`run test`](run-test.md) — Re-test a stored run, then apply on success
- [`run start`](run-start.md) — Continue the agent loop from a failed run
