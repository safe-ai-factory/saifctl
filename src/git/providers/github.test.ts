/**
 * Unit tests for GitHubProvider and the getGitProvider factory.
 *
 * All tests are pure/side-effect-free: execSync calls are mocked so no real
 * git repo is required, and fetch is mocked so no real HTTP calls are made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getGitProvider } from '../index.js';
import { GitHubProvider } from './github.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider() {
  return new GitHubProvider();
}

// ---------------------------------------------------------------------------
// getGitProvider factory
// ---------------------------------------------------------------------------

describe('getGitProvider', () => {
  it('returns a GitHubProvider for id "github"', () => {
    const p = getGitProvider('github');
    expect(p).toBeInstanceOf(GitHubProvider);
    expect(p.id).toBe('github');
  });

  it('is case-insensitive', () => {
    expect(getGitProvider('GitHub').id).toBe('github');
    expect(getGitProvider('GITHUB').id).toBe('github');
  });

  it('throws for unknown provider ids', () => {
    expect(() => getGitProvider('forgejo')).toThrow(/Unknown git provider "forgejo"/);
    expect(() => getGitProvider('azuredevops')).toThrow(/Unknown git provider "azuredevops"/);
    expect(() => getGitProvider('')).toThrow(/Unknown git provider/);
  });
});

// ---------------------------------------------------------------------------
// GitHubProvider.resolvePushUrl
// ---------------------------------------------------------------------------

describe('GitHubProvider.resolvePushUrl', () => {
  const FAKE_ROOT = '/tmp/repo';

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
  });

  it('passes through a full https URL unchanged when no token is set', () => {
    const p = makeProvider();
    const url = 'https://github.com/owner/repo.git';
    expect(p.resolvePushUrl(url, FAKE_ROOT)).toBe(url);
  });

  it('injects GITHUB_TOKEN into a github.com https URL', () => {
    process.env.GITHUB_TOKEN = 'tok123';
    const p = makeProvider();
    const result = p.resolvePushUrl('https://github.com/owner/repo.git', FAKE_ROOT);
    expect(result).toContain('x-access-token:tok123@github.com');
  });

  it('does not inject token into non-github.com https URLs', () => {
    process.env.GITHUB_TOKEN = 'tok123';
    const p = makeProvider();
    const url = 'https://gitlab.com/owner/repo.git';
    expect(p.resolvePushUrl(url, FAKE_ROOT)).toBe(url);
  });

  it('passes through git@ SSH URLs unchanged', () => {
    process.env.GITHUB_TOKEN = 'tok123';
    const p = makeProvider();
    const url = 'git@github.com:owner/repo.git';
    expect(p.resolvePushUrl(url, FAKE_ROOT)).toBe(url);
  });

  it('expands an owner/repo slug to a full github.com URL', () => {
    const p = makeProvider();
    const result = p.resolvePushUrl('owner/repo', FAKE_ROOT);
    expect(result).toBe('https://github.com/owner/repo.git');
  });

  it('injects token when expanding an owner/repo slug', () => {
    process.env.GITHUB_TOKEN = 'tok456';
    const p = makeProvider();
    const result = p.resolvePushUrl('owner/repo', FAKE_ROOT);
    expect(result).toContain('x-access-token:tok456@github.com');
  });

  it('throws for an unknown remote name when git remote get-url fails', () => {
    // Uses a non-existent projectDir so git fails — covers the execSync error branch.
    const p = makeProvider();
    expect(() => p.resolvePushUrl('nonexistent-remote', '/tmp/not-a-real-git-repo')).toThrow(
      /Cannot resolve push target "nonexistent-remote"/,
    );
  });
});

// ---------------------------------------------------------------------------
// GitHubProvider.extractRepoSlug
// ---------------------------------------------------------------------------

describe('GitHubProvider.extractRepoSlug', () => {
  const FAKE_ROOT = '/tmp/repo';

  it('extracts slug from a github.com https URL', () => {
    const p = makeProvider();
    expect(p.extractRepoSlug('https://github.com/owner/repo.git', FAKE_ROOT)).toBe('owner/repo');
    expect(p.extractRepoSlug('https://github.com/owner/repo', FAKE_ROOT)).toBe('owner/repo');
  });

  it('extracts slug from a git@ SSH URL', () => {
    const p = makeProvider();
    expect(p.extractRepoSlug('git@github.com:owner/repo.git', FAKE_ROOT)).toBe('owner/repo');
  });

  it('returns an owner/repo slug shorthand as-is', () => {
    const p = makeProvider();
    expect(p.extractRepoSlug('owner/repo', FAKE_ROOT)).toBe('owner/repo');
  });

  it('throws for unresolvable remote names', () => {
    const p = makeProvider();
    expect(() => p.extractRepoSlug('nonexistent-remote', FAKE_ROOT)).toThrow(
      /Cannot resolve remote/,
    );
  });

  it('throws when the URL cannot be parsed as a github.com address', () => {
    const p = makeProvider();
    expect(() => p.extractRepoSlug('https://bitbucket.org/owner/repo.git', FAKE_ROOT)).toThrow(
      /Cannot extract GitHub owner\/repo/,
    );
  });
});

// ---------------------------------------------------------------------------
// GitHubProvider.createPullRequest
// ---------------------------------------------------------------------------

describe('GitHubProvider.createPullRequest', () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
  });

  it('throws when GITHUB_TOKEN is not set', async () => {
    delete process.env.GITHUB_TOKEN;
    const p = makeProvider();
    await expect(
      p.createPullRequest({
        repoSlug: 'owner/repo',
        head: 'feature-branch',
        base: 'main',
        title: 'My PR',
        body: 'body',
      }),
    ).rejects.toThrow(/GITHUB_TOKEN is required/);
  });

  it('sends a POST to the GitHub pulls API and returns the html_url', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: 'https://github.com/owner/repo/pull/42' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const p = makeProvider();
    const url = await p.createPullRequest({
      repoSlug: 'owner/repo',
      head: 'feature-branch',
      base: 'main',
      title: 'My PR',
      body: 'body text',
    });

    expect(url).toBe('https://github.com/owner/repo/pull/42');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [apiUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(apiUrl).toBe('https://api.github.com/repos/owner/repo/pulls');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toMatchObject({ title: 'My PR', head: 'feature-branch', base: 'main' });
  });

  it('throws on non-ok API response', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 422,
        text: async () => 'Validation Failed',
      }),
    );

    const p = makeProvider();
    await expect(
      p.createPullRequest({
        repoSlug: 'owner/repo',
        head: 'branch',
        base: 'main',
        title: 'T',
        body: 'B',
      }),
    ).rejects.toThrow(/GitHub PR creation failed \(422\)/);
  });
});
