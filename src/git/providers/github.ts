import { execSync } from 'node:child_process';

import type { GitProvider, PullRequestOpts } from '../types.js';

/**
 * GitHub provider.
 *
 * Required env var: GITHUB_TOKEN (Personal Access Token or GitHub App token).
 * Used for: authenticated HTTPS pushes and Pull Request creation via the GitHub REST API.
 */
export class GitHubProvider implements GitProvider {
  readonly id = 'github';

  /**
   * Converts a push target argument to a full Git remote URL.
   *
   * Accepts:
   *   - A full Git URL (https://... or git@...) → used as-is, with GITHUB_TOKEN injected for https://github.com
   *   - A GitHub slug (owner/repo)              → expanded to https://github.com/owner/repo.git
   *   - A git remote name (e.g. 'origin')       → resolved via `git remote get-url`
   */
  resolvePushUrl(push: string, projectDir: string): string {
    if (push.startsWith('https://') || push.startsWith('git@') || push.startsWith('ssh://')) {
      return this.injectToken(push);
    }

    // GitHub slug: owner/repo (exactly one slash, no dots before it)
    if (/^[^/]+\/[^/]+$/.test(push) && !push.includes('.git')) {
      return this.injectToken(`https://github.com/${push}.git`);
    }

    // Treat as a named remote — resolve its URL from the local git config
    try {
      const url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
      return this.injectToken(url);
    } catch {
      throw new Error(
        `[orchestrator] Cannot resolve push target "${push}": not a URL, GitHub slug, or known remote.`,
      );
    }
  }

  /**
   * Extracts the "owner/repo" slug from a push target string or URL.
   */
  extractRepoSlug(push: string, projectDir: string): string {
    let url = push;

    // Resolve remote name to URL first
    if (!push.startsWith('https://') && !push.startsWith('git@') && !push.includes('/')) {
      try {
        url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
      } catch {
        throw new Error(`[orchestrator] Cannot resolve remote "${push}" to extract repo slug.`);
      }
    }

    // GitHub slug shorthand: owner/repo
    if (/^[^/]+\/[^/]+$/.test(url) && !url.includes('.')) {
      return url;
    }

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1]!;

    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1]!;

    throw new Error(`[orchestrator] Cannot extract GitHub owner/repo from push target "${push}".`);
  }

  /**
   * Opens a GitHub Pull Request using the GitHub REST API.
   * Reads GITHUB_TOKEN from the environment.
   */
  async createPullRequest(opts: PullRequestOpts): Promise<string> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('[orchestrator] GITHUB_TOKEN is required to create a GitHub Pull Request.');
    }

    const { repoSlug, head, base, title, body } = opts;
    const apiUrl = `https://api.github.com/repos/${repoSlug}/pulls`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title, body, head, base }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[orchestrator] GitHub PR creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { html_url: string };
    return data.html_url;
  }

  /**
   * Injects GITHUB_TOKEN as Basic-auth credentials into a github.com HTTPS URL,
   * enabling authenticated pushes without interactive prompts.
   * Non-github.com URLs and SSH URLs are returned unchanged.
   */
  private injectToken(url: string): string {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return url;
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'github.com') {
        parsed.username = 'x-access-token';
        parsed.password = token;
        return parsed.toString();
      }
    } catch {
      // Not a parseable URL (e.g. git@ SSH) — return as-is
    }
    return url;
  }
}
