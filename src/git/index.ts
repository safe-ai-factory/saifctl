/**
 * Git hosting provider abstraction.
 *
 * Use `getGitProvider(id)` to obtain the provider for a given CLI flag value.
 * Each provider reads its auth token from environment variables — tokens are
 * never passed as function arguments.
 *
 * Supported providers:
 *   'github'    — GITHUB_TOKEN
 *   'gitlab'    — GITLAB_TOKEN
 *   'bitbucket' — BITBUCKET_TOKEN + BITBUCKET_USERNAME
 *   'azure'     — AZURE_DEVOPS_TOKEN
 *   'gitea'     — GITEA_TOKEN + GITEA_USERNAME (+ optional GITEA_URL)
 */

import { AzureReposProvider } from './providers/azure.js';
import { BitbucketProvider } from './providers/bitbucket.js';
import { GiteaProvider } from './providers/gitea.js';
import { GitHubProvider } from './providers/github.js';
import { GitLabProvider } from './providers/gitlab.js';
import type { GitProvider } from './types.js';

export type { GitProvider, PullRequestOpts } from './types.js';

const SUPPORTED_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'azure', 'gitea'] as const;
/** Union of supported git hosting provider identifiers accepted by {@link getGitProvider}. */
export type GitProviderId = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Returns a GitProvider instance for the given provider ID.
 *
 * @param id - Provider identifier: 'github' (default), 'gitlab', 'bitbucket', 'azure', or 'gitea'.
 * @throws When an unsupported provider ID is given.
 */
export function getGitProvider(id: string | null): GitProvider {
  const normalized = (id ?? 'github').trim().toLowerCase();

  switch (normalized) {
    case 'github':
      return new GitHubProvider();
    case 'gitlab':
      return new GitLabProvider();
    case 'bitbucket':
      return new BitbucketProvider();
    case 'azure':
      return new AzureReposProvider();
    case 'gitea':
      return new GiteaProvider();
    default:
      throw new Error(
        `[orchestrator] Unknown git provider "${id}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`,
      );
  }
}
