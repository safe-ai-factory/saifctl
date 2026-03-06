import { execSync } from 'node:child_process';

import type { GitProvider, PullRequestOpts } from '../types.js';

/**
 * Azure Repos (Azure DevOps) provider.
 *
 * Required env var:
 *   AZURE_DEVOPS_TOKEN — Personal Access Token (PAT) with Code (Read & Write)
 *                        and Pull Request Contribute permissions.
 *
 * HTTPS push URL format:
 *   https://pat:{token}@dev.azure.com/{org}/{project}/_git/{repo}
 *
 * PR creation uses the Azure DevOps Git REST API 7.1:
 *   POST https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests
 *
 * Slug format (opaque string passed through PullRequestOpts.repoSlug):
 *   "{org}/{project}/{repo}" — three segments separated by forward slashes.
 *   extractRepoSlug() produces this; createPullRequest() parses it.
 */
export class AzureReposProvider implements GitProvider {
  readonly id = 'azure';

  /**
   * Converts a push target to a full Git remote URL ready for `git push`.
   *
   * Accepts:
   *   - A full Git URL (https://... or git@...) → used as-is, with token injected for HTTPS
   *   - An Azure slug (org/project/repo)        → expanded to https://dev.azure.com/org/project/_git/repo
   *   - A git remote name (e.g. 'origin')       → resolved via `git remote get-url`
   *
   * HTTPS credential injection: embeds the PAT as Basic-auth credentials
   * (`https://pat:{token}@dev.azure.com/...`). Only dev.azure.com HTTPS URLs
   * are modified; all other URLs are returned unchanged.
   * SSH URLs (git@ssh.dev.azure.com:...) are always passed through unchanged.
   */
  resolvePushUrl(push: string, projectDir: string): string {
    if (push.startsWith('https://') || push.startsWith('git@') || push.startsWith('ssh://')) {
      return this.injectToken(push);
    }

    // Azure slug: org/project/repo (exactly two slashes)
    if (this.isAzureSlug(push)) {
      const [org, project, repo] = push.split('/');
      return this.injectToken(`https://dev.azure.com/${org}/${project}/_git/${repo}`);
    }

    // Treat as a named remote — resolve its URL from the local git config
    try {
      const url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
      return this.injectToken(url);
    } catch {
      throw new Error(
        `[orchestrator] Cannot resolve push target "${push}": not a URL, Azure slug (org/project/repo), or known remote.`,
      );
    }
  }

  /**
   * Extracts the repository identifier from a push target as an opaque
   * three-segment slug: "org/project/repo".
   *
   * This slug is used internally by createPullRequest() to construct the API
   * URL. It is NOT a URL-safe path — it is parsed by splitting on '/'.
   *
   * Supported input formats:
   *   HTTPS (modern): https://dev.azure.com/org/project/_git/repo[.git]
   *   HTTPS (legacy): https://org.visualstudio.com/project/_git/repo[.git]
   *   SSH SCP:        git@ssh.dev.azure.com:v3/org/project/repo[.git]
   *   SSH URL:        ssh://git@ssh.dev.azure.com[:22]/org/project/repo[.git]
   *   Slug:           org/project/repo
   *   Remote:         origin (resolved via git remote get-url)
   */
  extractRepoSlug(push: string, projectDir: string): string {
    let url = push;

    // Resolve remote name to URL first
    if (!push.startsWith('https://') && !push.startsWith('git@') && !push.startsWith('ssh://')) {
      if (!this.isAzureSlug(push)) {
        try {
          url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
        } catch {
          throw new Error(`[orchestrator] Cannot resolve remote "${push}" to extract repo slug.`);
        }
      }
    }

    // Slug shorthand: org/project/repo (exactly two slashes, no protocol)
    if (this.isAzureSlug(url)) {
      return url;
    }

    // HTTPS (modern): https://dev.azure.com/org/project/_git/repo[.git]
    const httpsMatch = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}/${httpsMatch[3]}`;

    // HTTPS (legacy VSTS): https://org.visualstudio.com/project/_git/repo[.git]
    const vstsMatch = url.match(/([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/);
    if (vstsMatch) return `${vstsMatch[1]}/${vstsMatch[2]}/${vstsMatch[3]}`;

    // SSH SCP-like: git@ssh.dev.azure.com:v3/org/project/repo[.git]
    const sshScpMatch = url.match(
      /git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    );
    if (sshScpMatch) return `${sshScpMatch[1]}/${sshScpMatch[2]}/${sshScpMatch[3]}`;

    // SSH URL-like: ssh://git@ssh.dev.azure.com[:22]/org/project/repo[.git]
    const sshUrlMatch = url.match(
      /ssh:\/\/git@ssh\.dev\.azure\.com(?::\d+)?\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    );
    if (sshUrlMatch) return `${sshUrlMatch[1]}/${sshUrlMatch[2]}/${sshUrlMatch[3]}`;

    throw new Error(
      `[orchestrator] Cannot extract Azure org/project/repo from push target "${push}".`,
    );
  }

  /**
   * Opens an Azure Repos Pull Request using the Azure DevOps Git REST API 7.1.
   * Reads AZURE_DEVOPS_TOKEN from the environment.
   *
   * The repoSlug must be "org/project/repo" as returned by extractRepoSlug().
   *
   * Returns the web URL of the created PR:
   *   https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequests/{id}
   */
  async createPullRequest(opts: PullRequestOpts): Promise<string> {
    const token = process.env.AZURE_DEVOPS_TOKEN;
    if (!token) {
      throw new Error(
        '[orchestrator] AZURE_DEVOPS_TOKEN is required to create an Azure Repos Pull Request.',
      );
    }

    const { repoSlug, head, base, title, body } = opts;
    // Azure org/project/repo names cannot legally contain '/', so splitting on
    // '/' is safe — isAzureSlug() already enforces this constraint upstream.
    const parts = repoSlug.split('/');
    if (parts.length !== 3) {
      throw new Error(
        `[orchestrator] Azure repoSlug must be "org/project/repo", got "${repoSlug}".`,
      );
    }
    const [org, project, repo] = parts as [string, string, string];

    const apiUrl =
      `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullrequests` +
      `?api-version=7.1`;

    // Azure requires branch names in "refs/heads/{name}" format
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        // Azure DevOps Basic auth: any username, PAT as password (base64-encoded)
        Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        description: body,
        sourceRefName: `refs/heads/${head}`,
        targetRefName: `refs/heads/${base}`,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `[orchestrator] Azure Repos PR creation failed (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as {
      pullRequestId: number;
      repository: { remoteUrl: string };
    };
    return `${data.repository.remoteUrl}/pullrequests/${data.pullRequestId}`;
  }

  /**
   * Injects AZURE_DEVOPS_TOKEN as Basic-auth into dev.azure.com and
   * *.visualstudio.com HTTPS URLs.
   * Uses "pat" as the username (Azure DevOps ignores the username field).
   * When AZURE_DEVOPS_TOKEN is not set, the URL is returned unchanged and
   * the subsequent `git push` will fail with a 401 from Azure.
   * Non-Azure URLs and SSH URLs are always returned unchanged.
   */
  private injectToken(url: string): string {
    const token = process.env.AZURE_DEVOPS_TOKEN;
    if (!token) return url;
    try {
      const parsed = new URL(url);
      const isAzureHost =
        parsed.hostname === 'dev.azure.com' || parsed.hostname.endsWith('.visualstudio.com');
      if (isAzureHost && parsed.protocol === 'https:') {
        parsed.username = 'pat';
        parsed.password = token;
        return parsed.toString();
      }
    } catch {
      // Not a parseable URL (e.g. git@ SSH) — return as-is
    }
    return url;
  }

  /**
   * Returns true if the string looks like an Azure three-part slug: org/project/repo.
   * Each segment must consist only of URL-safe characters (letters, digits, hyphens,
   * underscores, dots) — this guards against false positives from file paths.
   * Azure org/project/repo names cannot legally contain forward slashes.
   */
  private isAzureSlug(s: string): boolean {
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s);
  }
}
