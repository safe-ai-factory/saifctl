# Git Providers in the Software Factory

This document describes the git provider abstraction: what it does, how to select a provider via the CLI, which providers exist, and how to add or use a custom provider. For the broader Git workflow (sandbox, patch extraction, worktree, push), see [swf-git.md](./swf-git.md).

## Table of Contents

1. [Overview](#1-overview)
2. [Tasks a Git Provider Fulfils](#2-tasks-a-git-provider-fulfils)
3. [Choosing a Provider via CLI](#3-choosing-a-provider-via-cli)
4. [Available Providers](#4-available-providers)
5. [Creating new providers](#5-creating-new-providers)
6. [Custom providers](#6-custom-providers)
7. [Token-in-URL security](#7-token-in-url-security)

---

## 1. Overview

The Software Factory uses Git for local operations (init, diff, apply, commit, worktree). The **git provider** abstraction handles only the _hosting-specific_ parts that differ between GitHub, GitLab, Bitbucket, Azure Repos, etc.:

- Resolving a push target to a full URL (including auth injection for HTTPS)
- Extracting the repository identifier for the provider's REST API
- Creating a Pull Request (or Merge Request) via the provider's API

The underlying `git push` command is the same for every provider. Only URL construction and the PR creation API call are provider-specific.

**Code location:** `src/git/`

- `types.ts` — `GitProvider` interface
- `providers/github.ts` — GitHub implementation
- `index.ts` — `getGitProvider(id)` factory

---

## 2. Tasks a Git Provider Fulfils

A git provider implements three methods.

### 2.1 `resolvePushUrl(push, projectDir)`

Converts a push target into a full Git remote URL ready for `git push`.

**Accepted push target formats:**

| Format        | Example                             | Behaviour                                                                                 |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Full Git URL  | `https://github.com/owner/repo.git` | Used as-is; token injected for HTTPS URLs when the host matches the provider              |
| Provider slug | `owner/repo`                        | Expanded to the provider's canonical HTTPS URL (e.g. `https://github.com/owner/repo.git`) |
| Remote name   | `origin`                            | Resolved via `git remote get-url origin`; result treated as above                         |

**Auth:** The provider injects its token into HTTPS URLs so `git push` can authenticate without interactive prompts. SSH URLs (`git@...`) are passed through unchanged. Tokens are read from environment variables only — never from function arguments.

### 2.2 `extractRepoSlug(push, projectDir)`

Extracts the repository identifier in the format expected by the provider's PR creation API.

- For GitHub/Bitbucket: typically `owner/repo`
- For GitLab: may be a full path like `group/subgroup/repo` or a numeric project ID

Used when creating a Pull/Merge Request after a successful push.

### 2.3 `createPullRequest(opts)`

Opens a Pull Request (GitHub/Bitbucket) or Merge Request (GitLab) via the provider's REST API.

**Inputs:** `repoSlug`, `head` (branch with changes), `base` (target branch), `title`, `body`

**Returns:** The HTML URL of the created PR/MR

**Auth:** The provider reads its token from an env var and uses it for the API call.

---

## 3. Choosing a Provider via CLI

Use the `--git-provider` flag on subcommands that support push and PR creation:

- `saifac feat run`
- `saifac run resume`
- `saifac run test`

**Syntax:**

```bash
saifac feat run --push owner/repo --pr --git-provider github
```

| Flag             | Values                                            | Default  | Description                                           |
| ---------------- | ------------------------------------------------- | -------- | ----------------------------------------------------- |
| `--git-provider` | `github`, `gitlab`, `bitbucket`, `azure`, `gitea` | `github` | Provider used for push URL resolution and PR creation |

**Notes:**

- `--git-provider` applies only when `--push` is set. Without `--push`, the branch stays local and the provider is not used.
- For `--pr` to work, you must also pass `--push`. The provider's token env var must be set.

**Example:**

```bash
# Push to GitHub and create a PR (uses GITHUB_TOKEN)
export GITHUB_TOKEN=ghp_...
saifac feat run --push origin --pr

# Push to GitLab and open a Merge Request (uses GITLAB_TOKEN)
export GITLAB_TOKEN=glpat-...
export GITLAB_URL=https://gitlab.mycompany.com  # omit to use gitlab.com
saifac feat run --push group/repo --pr --git-provider gitlab

# Push to Bitbucket and open a Pull Request (uses BITBUCKET_TOKEN + BITBUCKET_USERNAME)
export BITBUCKET_TOKEN=...
export BITBUCKET_USERNAME=myuser
saifac feat run --push workspace/repo --pr --git-provider bitbucket

# Push to Azure Repos and open a Pull Request (uses AZURE_DEVOPS_TOKEN)
export AZURE_DEVOPS_TOKEN=...
saifac feat run --push myorg/myproject/myrepo --pr --git-provider azure

# Push to Gitea and open a Pull Request (uses GITEA_TOKEN + GITEA_USERNAME)
export GITEA_TOKEN=...
export GITEA_USERNAME=myuser
export GITEA_URL=https://gitea.mycompany.com  # omit to use gitea.com
saifac feat run --push owner/repo --pr --git-provider gitea
```

---

## 4. Available Providers

### `github`

| Property    | Value                   |
| ----------- | ----------------------- |
| **ID**      | `github`                |
| **Env var** | `GITHUB_TOKEN`          |
| **Use for** | GitHub.com repositories |

**Token:** Personal Access Token (PAT) or GitHub App token. Create at: GitHub → Settings → Developer settings → Personal access tokens. Minimum scopes: `repo` (for push and PR creation).

**Push target formats:**

- Full URL: `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`
- Slug: `owner/repo` → expanded to `https://github.com/owner/repo.git`
- Remote: `origin` → resolved via `git remote get-url origin`

**PR creation:** Uses `POST https://api.github.com/repos/{owner}/{repo}/pulls`

---

### `gitlab`

| Property     | Value                                      |
| ------------ | ------------------------------------------ |
| **ID**       | `gitlab`                                   |
| **Env vars** | `GITLAB_TOKEN`, `GITLAB_URL` (optional)    |
| **Use for**  | GitLab.com or self-hosted GitLab instances |

**Token:** Personal Access Token (PAT) or Group/Project access token. Create at: GitLab → User Settings → Access Tokens. Minimum scopes: `api` (for MR creation) and `write_repository` (for push).

**Host:** Set `GITLAB_URL` to the base URL of your self-hosted instance (e.g. `https://gitlab.mycompany.com`). When not set, defaults to `https://gitlab.com`. Controls push token injection, slug expansion, and the MR API endpoint. The token is only injected into HTTPS URLs whose hostname matches `GITLAB_URL` — it is never sent to other hosts.

**Push target formats:**

- Full URL: `https://{host}/group/repo.git` or `git@{host}:group/repo.git`
- Path slug: `group/repo` or `group/subgroup/repo` → expanded using `GITLAB_URL`
- Remote: `origin` → resolved via `git remote get-url origin`

Multi-segment paths are fully supported: `group/subgroup/repo` is a valid slug and will be URL-encoded for the API call.

**MR creation:** Uses `POST {GITLAB_URL}/api/v4/projects/{url-encoded-path}/merge_requests` with `PRIVATE-TOKEN` header. The PR `body` maps to the MR `description` field. Self-hosted instances are fully supported when `GITLAB_URL` is set.

---

### `bitbucket`

| Property     | Value                                   |
| ------------ | --------------------------------------- |
| **ID**       | `bitbucket`                             |
| **Env vars** | `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME` |
| **Use for**  | Bitbucket Cloud repositories            |

**Token:** Personal Access Token (PAT) or Repository/Project access token. Create at: Bitbucket → Account Settings → App passwords (or Access tokens under the repository). Minimum scopes: `Repositories: Write` (for push) and `Pull requests: Write` (for PR creation).

**Username:** Your Bitbucket account username (not email). Required for embedding credentials in the HTTPS push URL (`https://{username}:{token}@bitbucket.org/...`).

**Push target formats:**

- Full URL: `https://bitbucket.org/workspace/repo.git` or `git@bitbucket.org:workspace/repo.git`
- Slug: `workspace/repo` → expanded to `https://bitbucket.org/workspace/repo.git`
- Remote: `origin` → resolved via `git remote get-url origin`

**PR creation:** Uses `POST https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}/pullrequests` with a `Bearer` token header.

---

### `azure`

| Property    | Value                                      |
| ----------- | ------------------------------------------ |
| **ID**      | `azure`                                    |
| **Env var** | `AZURE_DEVOPS_TOKEN`                       |
| **Use for** | Azure Repos (Azure DevOps / dev.azure.com) |

**Token:** Personal Access Token (PAT). Create at: Azure DevOps → User settings → Personal access tokens. Minimum scopes: `Code (Read & Write)` (for push) and `Pull Request Contribute` (for PR creation).

**Slug format:** Unlike GitHub/Bitbucket (which use two-part `owner/repo` slugs), Azure Repos requires three components: `{organization}/{project}/{repository}`. Pass this as the `--push` argument or let it be resolved from a remote URL.

**Push target formats:**

- Full URL (modern): `https://dev.azure.com/org/project/_git/repo`
- Full URL (legacy): `https://org.visualstudio.com/project/_git/repo`
- SSH (SCP): `git@ssh.dev.azure.com:v3/org/project/repo`
- SSH (URL): `ssh://git@ssh.dev.azure.com:22/org/project/repo`
- Slug: `org/project/repo` → expanded to `https://dev.azure.com/org/project/_git/repo`
- Remote: `origin` → resolved via `git remote get-url origin`

**PR creation:** Uses `POST https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1` with Basic auth (`base64(":token")`). Branch names are automatically wrapped in `refs/heads/` as required by the Azure API.

**Legacy URLs:** The old `org.visualstudio.com` format is also supported for both push auth injection and slug extraction — useful for Azure DevOps accounts created before the `dev.azure.com` migration.

**Limitation:** Azure DevOps Server (on-premises) is not supported.

---

### `gitea`

| Property     | Value                                                   |
| ------------ | ------------------------------------------------------- |
| **ID**       | `gitea`                                                 |
| **Env vars** | `GITEA_TOKEN`, `GITEA_USERNAME`, `GITEA_URL` (optional) |
| **Use for**  | Gitea Cloud (gitea.com) or self-hosted Gitea instances  |

**Token:** Personal Access Token with repository read/write permissions. Create at: Gitea → Settings → Applications → Access Tokens.

**Username:** Your Gitea account username. Required for embedding credentials in the HTTPS push URL.

**Host:** Set `GITEA_URL` to the base URL of your self-hosted instance (e.g. `https://gitea.mycompany.com`). When not set, defaults to `https://gitea.com`. This is used for both slug expansion and PR creation API calls. For full URLs and remote names, the host is inferred from the URL directly — `GITEA_URL` is only used when a plain `owner/repo` slug is given.

**Push target formats:**

- Full URL: `https://{host}/owner/repo[.git]` or `git@{host}:owner/repo[.git]`
- Slug: `owner/repo` → expanded using `GITEA_URL` (or `https://gitea.com`)
- Remote: `origin` → resolved via `git remote get-url origin`

**PR creation:** Uses `POST {host}/api/v1/repos/{owner}/{repo}/pulls` with an `Authorization: token {GITEA_TOKEN}` header. The host is inferred from the push target URL, not from `GITEA_URL`, so self-hosted instances work transparently when using full URLs or remote names.

---

## 5. Creating new providers

To add support for a new hosting provider (e.g. Gitea, Azure DevOps) or a custom/internal instance:

### Step 1: Implement the `GitProvider` interface

Create a new file under `src/git/providers/`, e.g. `gitea.ts`:

```typescript
import type { GitProvider, PullRequestOpts } from '../types.js';

export class GiteaProvider implements GitProvider {
  readonly id = 'gitea';

  resolvePushUrl(push: string, projectDir: string): string {
    // Handle https://, git@, slug (owner/repo), remote name
    // Inject GITEA_TOKEN for https:// URLs
    // ...
  }

  extractRepoSlug(push: string, projectDir: string): string {
    // Return owner/repo slug for the Gitea API
    // ...
  }

  async createPullRequest(opts: PullRequestOpts): Promise<string> {
    // POST to Gitea Pull Requests API
    // Read GITEA_TOKEN from process.env
    // Return the HTML URL of the created PR
    // ...
  }
}
```

Study the existing implementations in `src/git/providers/` as references. Key points:

- Read the token from `process.env.<PROVIDER>_TOKEN` inside the provider. Do not accept tokens as parameters.
- For HTTPS pushes, inject the token as Basic-auth credentials in the URL (e.g. `https://oauth2:${token}@gitlab.com/...`).
- For PR/MR creation, use `fetch()` with the provider's REST API. Handle non-ok responses and surface clear errors.

### Step 2: Register the provider in the factory

Edit `src/git/index.ts`:

1. Import the new provider class.
2. Add a `case` in `getGitProvider()`:

```typescript
import { GiteaProvider } from './providers/gitea.js';

// Inside getGitProvider():
case 'gitea':
  return new GiteaProvider();
```

3. Add the id to `SUPPORTED_PROVIDERS`:

```typescript
const SUPPORTED_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'gitea'] as const;
```

### Step 3: Document the provider

Add the new provider to this document (section 4) and to user-facing CLI docs — e.g. `docs/commands/feat-run.md` / `docs/commands/run-resume.md` and the `--git-provider` entry in `src/cli/args.ts` (`featRunArgs`).

### Step 4: Use it

Once registered, users can run:

```bash
export GITEA_TOKEN=...
saifac feat run --push origin --pr --git-provider gitea
```

---

## 6. Custom providers

The current design requires modifying the codebase to add a provider. A future enhancement could support loading providers from a path, e.g.:

```bash
saifac feat run --push origin --pr --git-provider ./my-gitea-provider.js
```

That would require dynamic `import()` of a module that exports a `GitProvider` implementation. Not implemented at this time.

---

## 7. Token-in-URL security

Embedding credentials in URLs is a common pattern for non-interactive `git push`, but URLs can appear in process lists, shells, or logs. To reduce exposure, each provider injects its token **only** when:

- The URL uses HTTPS, and
- The hostname matches the configured provider host (e.g. `github.com`, `GITLAB_URL`, `GITEA_URL`, or `bitbucket.org`).

If the push target points at a different host, the URL is returned unchanged — the token is never sent there.
