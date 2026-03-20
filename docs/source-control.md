# Push & Open PRs from the Factory

When your agent finishes and tests pass, the factory can push the feature branch and open a Pull Request for you. No manual `git push` or copy-pasting. Set `--push` and `--pr` once, and the orchestrator handles the rest.

This guide walks you through pushing to a branch, a URL, or your default remote — and creating PRs on GitHub, GitLab, Bitbucket, Azure Repos, or Gitea.

---

## Prerequisites

- The agent passed the tests.
- API key for your Git hosting provider.
- The token has **push** and **pull request** scopes (or equivalent).

---

## Quick Start

The simplest flow: push to `origin` and open a PR when the agent succeeds.

```bash
saifac feat run --push origin --pr
```

If you’re using GitHub, set `GITHUB_TOKEN` in your environment. The factory will push the feature branch when tests pass and create the PR automatically.

---

## Step 1: Choose Your Push Target

`--push` accepts three formats:

| Format       | Example                             | When to Use                                            |
| ------------ | ----------------------------------- | ------------------------------------------------------ |
| **Remote**   | `origin`                            | Your `origin` already points to the right repository.  |
| **Slug**     | `owner/repo`                        | Short, readable; expanded to the provider’s HTTPS URL. |
| **Full URL** | `https://github.com/owner/repo.git` | Explicit; useful for forks or alternate remotes.       |

### Using a Remote Name

If you typically push to `origin`:

```bash
saifac feat run --push origin --pr
```

The factory resolves `origin` via `git remote get-url origin` and uses that URL.

### Using a Slug

Provider-specific slugs are concise and easy to read:

```bash
# GitHub
saifac feat run --push owner/repo --pr

# GitLab (supports nested paths: group/subgroup/repo)
saifac feat run --push group/subgroup/repo --pr --git-provider gitlab

# Bitbucket (workspace/repo)
saifac feat run --push workspace/repo --pr --git-provider bitbucket

# Azure Repos (org/project/repo — three parts)
saifac feat run --push myorg/myproject/myrepo --pr --git-provider azure

# Gitea
saifac feat run --push owner/repo --pr --git-provider gitea
```

### Using a Full URL

For forks, mirrors, or non-default remotes:

```bash
saifac feat run --push https://github.com/your-org/your-repo.git --pr
```

HTTPS URLs work with token-based auth. SSH URLs (`git@github.com:owner/repo.git`) are passed through unchanged — use your SSH key as usual.

---

## Step 2: Set the Provider Token

Each provider reads its token from environment variables. Set the one that matches your `--git-provider`:

| Provider    | Env Vars                                                 |
| ----------- | -------------------------------------------------------- |
| `github`    | `GITHUB_TOKEN`                                           |
| `gitlab`    | `GITLAB_TOKEN` (+ optional `GITLAB_URL`)                 |
| `bitbucket` | `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`                  |
| `azure`     | `AZURE_DEVOPS_TOKEN`                                     |
| `gitea`     | `GITEA_TOKEN`, `GITEA_USERNAME` (+ optional `GITEA_URL`) |

### Example: GitHub

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

saifac feat run --push origin --pr
```

### Example: GitLab (self-hosted)

```bash
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
export GITLAB_URL=https://gitlab.mycompany.com

saifac feat run --push group/repo --pr --git-provider gitlab
```

### Example: Bitbucket

```bash
export BITBUCKET_TOKEN=your-token
export BITBUCKET_USERNAME=your-username

saifac feat run --push workspace/repo --pr --git-provider bitbucket
```

### Example: Azure Repos

```bash
export AZURE_DEVOPS_TOKEN=your-pat

saifac feat run --push org/project/repo --pr --git-provider azure
```

### Example: Gitea (self-hosted)

```bash
export GITEA_TOKEN=your-token
export GITEA_USERNAME=your-username
export GITEA_URL=https://gitea.mycompany.com

saifac feat run --push owner/repo --pr --git-provider gitea
```

---

## Step 3: Push Without Opening a PR

To push the branch only (no PR):

```bash
saifac feat run --push origin
```

Omit `--pr`. The branch is pushed; you create the PR manually in the UI or with `gh pr create`.

---

## Step 4: Which Commands Support Push & PR?

`--push` and `--pr` work on these subcommands:

| Command             | When push/PR happens                       |
| ------------------- | ------------------------------------------ |
| `saifac feat run`   | After agent succeeds and all tests pass    |
| `saifac run test`   | After the candidate patch passes all tests |
| `saifac run resume` | After resume completes successfully        |

Push and PR happen at the end of a successful run. If the agent hits `--max-runs` or you interrupt, nothing is pushed.

---

## Branch and Base

- **Feature branch:** Automatically created as `saifac/<featureName>-<runId>` after a successful run (separate from your working branch).
- **Base branch:** The branch you had checked out when the command started. The PR targets that branch.

---

## Troubleshooting

### "Error: --pr requires --push \<target\>"

You passed `--pr` without `--push`. Always use both:

```bash
saifac feat run --push origin --pr
```

### Push fails with 401 or 403

- Ensure your token has **write** (push) and **pull request** permissions.
- For HTTPS URLs, the token is injected automatically. If you use SSH, the factory does not inject tokens — rely on your SSH agent.

### Wrong provider selected

The default provider is `github`. For others, set `--git-provider`:

```bash
saifac feat run --push origin --pr --git-provider gitlab
```

### Azure slug format

Azure Repos uses three segments: `org/project/repo`. GitHub-style `owner/repo` will not work:

```bash
# Correct for Azure
saifac feat run --push myorg/myproject/myrepo --pr --git-provider azure
```

---

## See Also

- [commands](commands/README.md) — Commands.
- [env-vars.md](env-vars.md) — Env vars.
