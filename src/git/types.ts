/**
 * Abstract Git hosting provider interface.
 *
 * Implementations handle the provider-specific concerns of pushing branches
 * and opening pull/merge requests. The underlying `git push` command itself
 * is provider-agnostic; only URL construction and the REST API call differ.
 *
 * Auth tokens are always read from environment variables inside each
 * implementation — they are never passed as function arguments.
 */

export interface PullRequestOpts {
  /** Provider-specific repository identifier (e.g. 'owner/repo' for GitHub/Bitbucket). */
  repoSlug: string;
  /** Branch that contains the changes. */
  head: string;
  /** Target branch to merge into. */
  base: string;
  title: string;
  body: string;
}

export interface GitProvider {
  /** Short identifier used in CLI flags and log messages (e.g. 'github', 'gitlab'). */
  readonly id: string;

  /**
   * Resolves a push target to a full Git remote URL ready for `git push`.
   *
   * Accepts:
   *   - A full Git URL (https://... or git@...) — used as-is, with token injected for HTTPS
   *   - A provider-style slug (e.g. 'owner/repo') — expanded to the provider's HTTPS URL
   *   - A named git remote (e.g. 'origin') — resolved via `git remote get-url`
   */
  resolvePushUrl(push: string, projectDir: string): string;

  /**
   * Extracts the repository identifier from a push target, in the format
   * expected by this provider's `createPullRequest` API.
   *
   * For GitHub and Bitbucket this is typically 'owner/repo'.
   * For GitLab a full project path like 'group/subgroup/repo' may be needed —
   * each provider implementation handles its own slug format.
   */
  extractRepoSlug(push: string, projectDir: string): string;

  /**
   * Opens a Pull Request (or Merge Request) via the provider's REST API.
   *
   * @returns The HTML URL of the created PR/MR.
   * @throws When the required auth token env var is missing or the API call fails.
   */
  createPullRequest(opts: PullRequestOpts): Promise<string>;
}
