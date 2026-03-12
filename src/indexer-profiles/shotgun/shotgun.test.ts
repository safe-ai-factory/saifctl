import * as childProcess from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryShotgunIndex, resolveShotgunPython } from './shotgun.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

describe('resolveShotgunPython', () => {
  afterEach(() => {
    delete process.env.SHOTGUN_PYTHON;
  });

  it('defaults to "python" when SHOTGUN_PYTHON is not set', () => {
    delete process.env.SHOTGUN_PYTHON;
    expect(resolveShotgunPython()).toBe('python');
  });

  it('returns SHOTGUN_PYTHON when set', () => {
    process.env.SHOTGUN_PYTHON = '/usr/local/bin/python3.12';
    expect(resolveShotgunPython()).toBe('/usr/local/bin/python3.12');
  });

  it('trims whitespace from SHOTGUN_PYTHON', () => {
    process.env.SHOTGUN_PYTHON = '  /path/to/python  ';
    expect(resolveShotgunPython()).toBe('/path/to/python');
  });
});

describe('queryShotgunIndex', () => {
  afterEach(() => {
    delete process.env.SHOTGUN_PYTHON;
    vi.clearAllMocks();
  });

  it('invokes python -m shotgun.main and returns raw output', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: 'Results: 3 rows\nname | path\n---\nfoo | src/foo.ts',
      stderr: '',
      error: undefined,
    } as ReturnType<typeof childProcess.spawnSync>);

    const result = queryShotgunIndex({
      graphId: 'abc123',
      question: 'where is foo?',
      projectDir: '/repo',
    });
    expect(result.raw).toContain('Results: 3 rows');
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'python',
      ['-m', 'shotgun.main', 'codebase', 'query', 'abc123', 'where is foo?'],
      expect.objectContaining({ encoding: 'utf-8', cwd: '/repo' }),
    );
  });

  it('uses SHOTGUN_PYTHON when set', () => {
    process.env.SHOTGUN_PYTHON = '/path/to/.venv/bin/python';
    vi.mocked(childProcess.spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: 'ok',
      stderr: '',
      error: undefined,
    } as ReturnType<typeof childProcess.spawnSync>);

    queryShotgunIndex({ graphId: 'g1', question: 'q', projectDir: '/repo' });
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      '/path/to/.venv/bin/python',
      ['-m', 'shotgun.main', 'codebase', 'query', 'g1', 'q'],
      expect.objectContaining({ encoding: 'utf-8', cwd: '/repo' }),
    );
  });

  it('throws on non-zero exit status', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'No graph found',
      error: undefined,
    } as ReturnType<typeof childProcess.spawnSync>);

    expect(() => queryShotgunIndex({ graphId: 'bad', question: 'q', projectDir: '/repo' })).toThrow(
      /shotgun\.main exited with code 1/,
    );
  });
});
