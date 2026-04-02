/**
 * Unit tests for generatePRSummary (pr-summarizer.ts).
 *
 * Verifies:
 *   - The agent is called with a prompt containing featureName, spec, proposal, tasks, and diff.
 *   - The structured output (title + body) is returned correctly.
 *   - Missing spec files are handled gracefully (omitted from prompt, no crash).
 *   - Large diffs are truncated to file-header-only summary.
 *   - The agent falling back to empty result throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generatePRSummary, type PRSummary } from './pr-summarizer.js';

// generateMock is used by prSummarizerAgent.generate — hoisted so it's
// available when the mock factory runs.
const generateMock = vi.hoisted(() => vi.fn());
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(() => ({ generate: generateMock })),
}));

const readFileMock = vi.hoisted(() => vi.fn<(path: string) => Promise<Buffer | string>>());
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

function makeSummary(title: string, body: string): PRSummary {
  return { title, body };
}

const baseFeature = {
  name: 'greet-cmd',
  absolutePath: '/repo/saifctl/features/greet-cmd',
  relativePath: 'saifctl/features/greet-cmd',
} as const;

describe('generatePRSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const baseOpts = {
    feature: baseFeature,
    patchFile: '/sandbox/patch.diff',
    llm: { globalModel: 'openai/gpt-4o' },
  };

  it('returns the agent structured output as PRSummary', async () => {
    const expected = makeSummary(
      'feat(greet-cmd): add greet CLI command',
      '## Summary\nAdds a greet command.\n\n## Changes\n- scripts/commands/greet.ts\n\n## Testing\n- Run pnpm greet Alice',
    );

    readFileMock.mockResolvedValue('file content');
    generateMock.mockResolvedValue({ object: expected });

    const result = await generatePRSummary(baseOpts);

    expect(result.title).toBe(expected.title);
    expect(result.body).toBe(expected.body);
  });

  it('calls generate once with structuredOutput schema', async () => {
    readFileMock.mockResolvedValue('content');
    generateMock.mockResolvedValue({
      object: makeSummary('feat(x): something', '## Summary\nOk'),
    });

    await generatePRSummary(baseOpts);

    expect(generateMock).toHaveBeenCalledTimes(1);
    const [, options] = generateMock.mock.calls[0] as [unknown, { structuredOutput: unknown }];
    expect(options).toHaveProperty('structuredOutput.schema');
  });

  it('includes featureName and diff content in the prompt', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === baseOpts.patchFile) return 'diff --git a/foo.ts b/foo.ts\n+const x = 1;';
      return '';
    });
    generateMock.mockResolvedValue({
      object: makeSummary('feat(greet-cmd): x', '## Summary\nOk'),
    });

    await generatePRSummary(baseOpts);

    const [messages] = generateMock.mock.calls[0] as [Array<{ content: string }>];
    const prompt = messages[0].content;
    expect(prompt).toContain('greet-cmd');
    expect(prompt).toContain('diff --git');
  });

  it('handles missing spec files gracefully without crashing', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      if (p === baseOpts.patchFile) return 'diff --git a/x.ts b/x.ts\n+1';
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    generateMock.mockResolvedValue({
      object: makeSummary('feat(greet-cmd): minimal', '## Summary\nOk'),
    });

    await expect(generatePRSummary(baseOpts)).resolves.toMatchObject({ title: expect.any(String) });
  });

  it('uses "(no diff available)" when patch file is missing', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readFileMock.mockRejectedValue(err);
    generateMock.mockResolvedValue({
      object: makeSummary('feat(x): y', '## Summary\nOk'),
    });

    await generatePRSummary(baseOpts);

    const [messages] = generateMock.mock.calls[0] as [Array<{ content: string }>];
    expect(messages[0].content).toContain('(no diff available)');
  });

  it('truncates large diffs to file-header summary', async () => {
    // 40_000 lines × ~5 bytes each ≈ 200KB, above the 100KB MAX_DIFF_BYTES limit
    const bigDiff =
      'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n' + '+xxxx\n'.repeat(40_000);

    readFileMock.mockImplementation(async (p: string) => {
      if (p === baseOpts.patchFile) return bigDiff;
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    });
    generateMock.mockResolvedValue({
      object: makeSummary('feat(x): big', '## Summary\nOk'),
    });

    await generatePRSummary(baseOpts);

    const [messages] = generateMock.mock.calls[0] as [Array<{ content: string }>];
    const prompt = messages[0].content;
    expect(prompt).toContain('truncated');
    expect(prompt).toContain('diff --git a/big.ts');
    // Full line content should not appear
    expect(prompt).not.toContain('+x\n'.repeat(100));
  });

  it('throws when agent returns empty title', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readFileMock.mockRejectedValue(err);
    generateMock.mockResolvedValue({ object: { title: '', body: 'some body' } });

    await expect(generatePRSummary(baseOpts)).rejects.toThrow('empty title or body');
  });

  it('throws when agent returns empty body', async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readFileMock.mockRejectedValue(err);
    generateMock.mockResolvedValue({ object: { title: 'feat(x): y', body: '' } });

    await expect(generatePRSummary(baseOpts)).rejects.toThrow('empty title or body');
  });
});
