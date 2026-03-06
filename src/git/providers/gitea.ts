import { execSync } from 'node:child_process';

import type { GitProvider, PullRequestOpts } from '../types.js';

const DEFAULT_GITEA_HOST = 'gitea.com';

/**
 * Gitea provider (self-hosted or gitea.com).
 *
 * Required env vars:
 *   GITEA_TOKEN    — Personal Access Token with repository read/write permissions.
 *   GITEA_USERNAME — Gitea account username (required for HTTPS push auth).
 *
 * Optional env var:
 *   GITEA_URL — Base URL of the Gitea instance, e.g. https://gitea.mycompany.com
 *               Must not contain '|'. Defaults to https://gitea.com when not set.
 *               Used for:
 *                 1. Expanding owner/repo slugs to full HTTPS URLs.
 *                 2. Constructing the API endpoint for PR creation when a slug is given.
 *               For full URL and remote inputs, the host is inferred from the URL directly.
 *
 * HTTPS push URL format: https://{username}:{token}@{host}/owner/repo.git
 *
 * PR creation uses the Gitea REST API v1:
 *   POST {host}/api/v1/repos/{owner}/{repo}/pulls
 */
export class GiteaProvider implements GitProvider {
  readonly id = 'gitea';

  /**
   * Converts a push target to a full Git remote URL ready for `git push`.
   *
   * Accepts:
   *   - A full Git URL (https://... or git@...) → used as-is, with credentials injected for HTTPS
   *   - An owner/repo slug                      → expanded using GITEA_URL (or https://gitea.com)
   *   - A git remote name (e.g. 'origin')       → resolved via `git remote get-url`
   *
   * HTTPS credential injection: embeds GITEA_USERNAME and GITEA_TOKEN into the URL,
   * but only for HTTPS URLs whose hostname matches the configured Gitea host. Both
   * env vars must be set; if either is absent, the URL is returned unchanged.
   * SSH URLs (git@...) are always passed through unchanged.
   */
  resolvePushUrl(push: string, projectDir: string): string {
    if (push.startsWith('https://') || push.startsWith('git@') || push.startsWith('ssh://')) {
      return this.injectToken(push);
    }

    // owner/repo slug — expand to the configured Gitea host
    if (this.isOwnerRepoSlug(push)) {
      const clean = push.replace(/\.git$/, '');
      const base = this.gitBaseUrl();
      return this.injectToken(`${base}/${clean}.git`);
    }

    // Treat as a named remote — resolve its URL from the local git config
    try {
      const url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
      return this.injectToken(url);
    } catch {
      throw new Error(
        `[orchestrator] Cannot resolve push target "${push}": not a URL, Gitea slug (owner/repo), or known remote.`,
      );
    }
  }

  /**
   * Extracts the "owner/repo" slug from a push target.
   *
   * Used as part of the API URL:
   *   POST {host}/api/v1/repos/{owner}/{repo}/pulls
   *
   * Also encodes the inferred host so createPullRequest() can call the correct
   * API endpoint for self-hosted instances. The host and slug are combined as
   * an opaque string: "{host}|{owner}/{repo}".
   *
   * createPullRequest() splits on the first '|' to recover both parts.
   * GITEA_URL must not contain '|'; a guard is applied in gitBaseUrl().
   *
   * Supported input formats:
   *   HTTPS:    https://[user:pass@]{host}/owner/repo[.git]  (userinfo is stripped)
   *   SSH SCP:  git@{host}:owner/repo[.git]
   *   SSH URL:  ssh://[user@]{host}/owner/repo[.git]
   *   Slug:     owner/repo[.git]  (uses GITEA_URL as host)
   *   Remote:   origin  (resolved via git remote get-url)
   */
  extractRepoSlug(push: string, projectDir: string): string {
    let url = push;

    // Resolve remote name to URL first
    if (!push.startsWith('https://') && !push.startsWith('git@') && !push.startsWith('ssh://')) {
      if (!this.isOwnerRepoSlug(push)) {
        try {
          url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
        } catch {
          throw new Error(`[orchestrator] Cannot resolve remote "${push}" to extract repo slug.`);
        }
      }
    }

    // owner/repo slug shorthand — use GITEA_URL as the host
    if (this.isOwnerRepoSlug(url)) {
      const clean = url.replace(/\.git$/, '');
      return `${this.gitBaseUrl()}|${clean}`;
    }

    // HTTPS: https://[userinfo@]{host}/owner/repo[.git]
    // Strip any embedded userinfo (user:pass@) from the captured host.
    const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) {
      const host = httpsMatch[1]!.replace(/^[^@]+@/, '');
      return `https://${host}|${httpsMatch[2]}`;
    }

    // SSH SCP: git@{host}:owner/repo[.git]
    const sshScpMatch = url.match(/^git@([^:]+):([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshScpMatch) return `https://${sshScpMatch[1]}|${sshScpMatch[2]}`;

    // SSH URL: ssh://[user@]{host}/owner/repo[.git]
    const sshUrlMatch = url.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshUrlMatch) return `https://${sshUrlMatch[1]}|${sshUrlMatch[2]}`;

    throw new Error(`[orchestrator] Cannot extract Gitea owner/repo from push target "${push}".`);
  }

  /**
   * Opens a Gitea Pull Request using the Gitea REST API v1.
   * Reads GITEA_TOKEN from the environment.
   *
   * The repoSlug must be "{host}|{owner}/{repo}" as returned by extractRepoSlug(),
   * where host is a full base URL like https://gitea.mycompany.com.
   */
  async createPullRequest(opts: PullRequestOpts): Promise<string> {
    const token = process.env.GITEA_TOKEN;
    if (!token) {
      throw new Error('[orchestrator] GITEA_TOKEN is required to create a Gitea Pull Request.');
    }

    const { repoSlug, head, base, title, body } = opts;
    const pipeIdx = repoSlug.indexOf('|');
    if (pipeIdx === -1) {
      throw new Error(
        `[orchestrator] Gitea repoSlug must be "host|owner/repo", got "${repoSlug}".`,
      );
    }
    const host = repoSlug.slice(0, pipeIdx);
    const ownerRepo = repoSlug.slice(pipeIdx + 1);
    const apiUrl = `${host}/api/v1/repos/${ownerRepo}/pulls`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, head, base }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[orchestrator] Gitea PR creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { html_url: string };
    return data.html_url;
  }

  /**
   * Injects GITEA_USERNAME and GITEA_TOKEN as Basic-auth credentials into HTTPS
   * URLs whose hostname matches the configured Gitea host. Both env vars must be
   * set; if either is absent, the URL is returned unchanged.
   *
   * Credentials are only injected for the same host as GITEA_URL (or gitea.com)
   * to prevent accidentally leaking credentials to other HTTPS servers.
   * SSH URLs are always returned unchanged.
   */
  private injectToken(url: string): string {
    const token = process.env.GITEA_TOKEN;
    const username = process.env.GITEA_USERNAME;
    if (!token || !username) return url;
    try {
      const parsed = new URL(url);
      const configuredHost = new URL(this.gitBaseUrl()).hostname;
      if (parsed.protocol === 'https:' && parsed.hostname === configuredHost) {
        parsed.username = username;
        parsed.password = token;
        return parsed.toString();
      }
    } catch {
      // Not a parseable URL (e.g. git@ SSH) — return as-is
    }
    return url;
  }

  /**
   * Returns the configured Gitea base URL (no trailing slash).
   * Falls back to https://gitea.com when GITEA_URL is not set.
   * Throws if the URL contains '|', which would corrupt the opaque slug encoding.
   */
  private gitBaseUrl(): string {
    const raw = process.env.GITEA_URL ?? `https://${DEFAULT_GITEA_HOST}`;
    const url = raw.replace(/\/$/, '');
    if (url.includes('|')) {
      throw new Error(`[orchestrator] GITEA_URL must not contain '|': "${url}".`);
    }
    return url;
  }

  /**
   * Returns true if the string is a simple "owner/repo" or "owner/repo.git" slug.
   * Accepts exactly one slash, no protocol, not a git@ URL.
   * Dots are allowed (e.g. "owner/my.repo" or "owner/repo.git") since Gitea
   * repository names can contain them.
   */
  private isOwnerRepoSlug(s: string): boolean {
    return /^[^/]+\/[^/]+$/.test(s) && !s.includes('://') && !s.startsWith('git@');
  }
}
