import { execSync } from 'node:child_process';

import type { GitProvider, PullRequestOpts } from '../types.js';

const DEFAULT_GITLAB_HOST = 'gitlab.com';

/**
 * GitLab provider.
 *
 * Required env var: GITLAB_TOKEN (Personal Access Token or Group/Project access token).
 * Used for: authenticated HTTPS pushes and Merge Request creation via the GitLab REST API.
 *
 * Optional env var:
 *   GITLAB_URL — Base URL of the GitLab instance, e.g. https://gitlab.mycompany.com
 *               Defaults to https://gitlab.com when not set.
 *               Controls:
 *                 1. Which HTTPS host receives the injected token during push.
 *                 2. Expanding path slugs (group/repo) to full HTTPS URLs.
 *                 3. The MR creation API endpoint.
 *
 * HTTPS push URL format: https://oauth2:{token}@{host}/group/repo.git
 *
 * MR creation uses the GitLab REST API v4:
 *   POST {host}/api/v4/projects/{url-encoded-path}/merge_requests
 */
export class GitLabProvider implements GitProvider {
  readonly id = 'gitlab';

  /**
   * Converts a push target to a full Git remote URL.
   *
   * Accepts:
   *   - A full Git URL (https://... or git@...) → used as-is, with token injected for HTTPS
   *     when the hostname matches GITLAB_URL (or gitlab.com).
   *   - A GitLab path slug (group/project or group/subgroup/project) → expanded using GITLAB_URL
   *   - A git remote name (e.g. 'origin') → resolved via `git remote get-url`
   */
  resolvePushUrl(push: string, projectDir: string): string {
    if (push.startsWith('https://') || push.startsWith('git@') || push.startsWith('ssh://')) {
      return this.injectToken(push);
    }

    // GitLab path slug: one or more path segments with slashes (strip trailing .git if present)
    if (push.includes('/')) {
      const clean = push.replace(/\.git$/, '');
      return this.injectToken(`${this.gitBaseUrl()}/${clean}.git`);
    }

    // Treat as a named remote — resolve its URL from the local git config
    try {
      const url = execSync(`git remote get-url ${push}`, { cwd: projectDir }).toString().trim();
      return this.injectToken(url);
    } catch {
      throw new Error(
        `[orchestrator] Cannot resolve push target "${push}": not a URL, GitLab path, or known remote.`,
      );
    }
  }

  /**
   * Extracts the URL-encoded project path from a push target.
   *
   * GitLab's REST API identifies projects by their URL-encoded path, e.g.
   * "group%2Fsubgroup%2Fproject" for a project at group/subgroup/project.
   * Single-segment paths (bare project names) are not valid on GitLab.com.
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

    // Path slug shorthand: contains slashes but no protocol or hostname indicators
    if (url.includes('/') && !url.includes('://') && !url.startsWith('git@')) {
      const clean = url.replace(/\.git$/, '');
      return encodeURIComponent(clean);
    }

    // HTTPS: https://{host}/group/subgroup/project.git
    const httpsMatch = url.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return encodeURIComponent(httpsMatch[1]!);
    }

    // SSH: git@{host}:group/subgroup/project.git
    const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return encodeURIComponent(sshMatch[1]!);
    }

    throw new Error(
      `[orchestrator] Cannot extract GitLab project path from push target "${push}".`,
    );
  }

  /**
   * Opens a GitLab Merge Request using the GitLab REST API v4.
   * Reads GITLAB_TOKEN from the environment.
   *
   * Uses GITLAB_URL (or https://gitlab.com) as the API host, so self-hosted
   * instances are fully supported for MR creation when GITLAB_URL is set.
   */
  async createPullRequest(opts: PullRequestOpts): Promise<string> {
    const token = process.env.GITLAB_TOKEN;
    if (!token) {
      throw new Error('[orchestrator] GITLAB_TOKEN is required to create a GitLab Merge Request.');
    }

    const { repoSlug, head, base, title, body } = opts;
    const apiUrl = `${this.gitBaseUrl()}/api/v4/projects/${repoSlug}/merge_requests`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_branch: head,
        target_branch: base,
        title,
        description: body,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[orchestrator] GitLab MR creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { web_url: string };
    return data.web_url;
  }

  /**
   * Injects GITLAB_TOKEN as oauth2 Basic-auth credentials into HTTPS URLs
   * whose hostname matches GITLAB_URL (or gitlab.com when not set).
   * Credentials are never injected into other hosts.
   * SSH URLs (git@...) are always returned unchanged.
   */
  private injectToken(url: string): string {
    const token = process.env.GITLAB_TOKEN;
    if (!token) return url;
    try {
      const parsed = new URL(url);
      const configuredHost = new URL(this.gitBaseUrl()).hostname;
      if (parsed.protocol === 'https:' && parsed.hostname === configuredHost) {
        parsed.username = 'oauth2';
        parsed.password = token;
        return parsed.toString();
      }
    } catch {
      // Not a parseable URL (e.g. git@ SSH) — return as-is
    }
    return url;
  }

  /**
   * Returns the configured GitLab base URL (no trailing slash).
   * Falls back to https://gitlab.com when GITLAB_URL is not set.
   */
  private gitBaseUrl(): string {
    const raw = process.env.GITLAB_URL ?? `https://${DEFAULT_GITLAB_HOST}`;
    return raw.replace(/\/$/, '');
  }
}
