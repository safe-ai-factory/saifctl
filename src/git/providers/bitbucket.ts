import { execSync } from 'node:child_process';

import type { GitProvider, PullRequestOpts } from '../types.js';

/**
 * Bitbucket Cloud provider.
 *
 * Required env vars:
 *   BITBUCKET_TOKEN    — Personal Access Token (PAT) or Repository/Project access token.
 *   BITBUCKET_USERNAME — Bitbucket account username (required for HTTPS push auth).
 *
 * HTTPS push URL format: https://{username}:{token}@bitbucket.org/{workspace}/{repo}.git
 *
 * PR creation uses the Bitbucket Cloud REST API 2.0.
 *
 * Limitation: HTTPS credential injection and API calls are only supported for
 * bitbucket.org (Bitbucket Cloud). Bitbucket Server / Data Center self-hosted
 * instances are not supported.
 */
export class BitbucketProvider implements GitProvider {
  readonly id = 'bitbucket';

  /**
   * Converts a push target to a full Git remote URL.
   *
   * Accepts:
   *   - A full Git URL (https://... or git@...) → used as-is, with credentials injected for HTTPS
   *   - A Bitbucket slug (workspace/repo) → expanded to https://bitbucket.org/workspace/repo.git
   *   - A git remote name (e.g. 'origin') → resolved via `git remote get-url`
   *
   * HTTPS credential injection requires both BITBUCKET_USERNAME and BITBUCKET_TOKEN.
   * When only one is set or neither is set, the URL is returned unchanged.
   */
  resolvePushUrl(push: string, projectDir: string): string {
    if (push.startsWith('https://') || push.startsWith('git@') || push.startsWith('ssh://')) {
      return this.injectToken(push);
    }

    // Bitbucket slug: workspace/repo (strip trailing .git if present)
    if (push.includes('/')) {
      const clean = push.replace(/\.git$/, '');
      return this.injectToken(`https://bitbucket.org/${clean}.git`);
    }

    // Treat as a named remote — resolve its URL from the local git config
    try {
      const url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
      return this.injectToken(url);
    } catch {
      throw new Error(
        `[orchestrator] Cannot resolve push target "${push}": not a URL, Bitbucket slug, or known remote.`,
      );
    }
  }

  /**
   * Extracts the "workspace/repo_slug" from a push target.
   *
   * Used as the path in the Bitbucket REST API:
   *   POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests
   *
   * Returns a plain "workspace/repo" string (NOT URL-encoded), since the
   * Bitbucket Cloud API uses workspace and repo_slug as separate path segments.
   * This differs from the GitLab provider, which URL-encodes its project path
   * (e.g. `group%2Frepo`) for a single-segment project identifier.
   */
  extractRepoSlug(push: string, projectDir: string): string {
    let url = push;

    // Resolve remote name to URL first
    if (!push.startsWith('https://') && !push.startsWith('git@') && !push.startsWith('ssh://')) {
      if (!push.includes('/')) {
        try {
          url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
        } catch {
          throw new Error(`[orchestrator] Cannot resolve remote "${push}" to extract repo slug.`);
        }
      }
    }

    // Path slug shorthand: workspace/repo (contains slash, no protocol)
    if (url.includes('/') && !url.includes('://') && !url.startsWith('git@')) {
      return url.replace(/\.git$/, '');
    }

    // HTTPS: https://bitbucket.org/workspace/repo.git
    const httpsMatch = url.match(/bitbucket\.org\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1]!;

    // SSH (SCP-like): git@bitbucket.org:workspace/repo.git
    const sshMatch = url.match(/git@bitbucket\.org:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1]!;

    // SSH (URL-like): ssh://git@bitbucket.org/workspace/repo.git
    const sshUrlMatch = url.match(/ssh:\/\/git@bitbucket\.org\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshUrlMatch) return sshUrlMatch[1]!;

    throw new Error(
      `[orchestrator] Cannot extract Bitbucket workspace/repo from push target "${push}".`,
    );
  }

  /**
   * Opens a Bitbucket Pull Request using the Bitbucket Cloud REST API 2.0.
   * Reads BITBUCKET_TOKEN from the environment.
   *
   * The repoSlug must be in "workspace/repo_slug" format as returned by
   * extractRepoSlug().
   */
  async createPullRequest(opts: PullRequestOpts): Promise<string> {
    const token = process.env.BITBUCKET_TOKEN;
    if (!token) {
      throw new Error(
        '[orchestrator] BITBUCKET_TOKEN is required to create a Bitbucket Pull Request.',
      );
    }

    const { repoSlug, head, base, title, body } = opts;
    const apiUrl = `https://api.bitbucket.org/2.0/repositories/${repoSlug}/pullrequests`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        description: body,
        source: { branch: { name: head } },
        destination: { branch: { name: base } },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[orchestrator] Bitbucket PR creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { links: { html: { href: string } } };
    return data.links.html.href;
  }

  /**
   * Injects BITBUCKET_USERNAME and BITBUCKET_TOKEN as Basic-auth credentials
   * into bitbucket.org HTTPS URLs. Both env vars must be set; if either is
   * absent the URL is returned unchanged.
   * SSH URLs (git@...) are returned unchanged.
   */
  private injectToken(url: string): string {
    const token = process.env.BITBUCKET_TOKEN;
    const username = process.env.BITBUCKET_USERNAME;
    if (!token || !username) return url;
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'bitbucket.org' && parsed.protocol === 'https:') {
        parsed.username = username;
        parsed.password = token;
        return parsed.toString();
      }
    } catch {
      // Not a parseable URL (e.g. git@ SSH) — return as-is
    }
    return url;
  }
}
