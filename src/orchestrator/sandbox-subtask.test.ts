/**
 * Tests for subtask signaling helpers in sandbox.ts.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  subtaskDonePath,
  subtaskExitPath,
  subtaskNextPath,
  subtaskRetriesPath,
} from '../constants.js';
import { pathExists, readUtf8 } from '../utils/io.js';
import {
  pollSubtaskDone,
  prepareSubtaskSignalDir,
  updateSandboxSubtaskScripts,
  writeSubtaskExitSignal,
  writeSubtaskNextPrompt,
  writeSubtaskRetriesOverride,
} from './sandbox.js';

describe('updateSandboxSubtaskScripts', () => {
  let base: string;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('writes gate.sh with chmod 0755 and leaves agent.sh untouched when agentScript omitted', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    const saifctlPath = join(base, 'saifctl');
    await mkdir(saifctlPath, { recursive: true });
    await writeFile(join(saifctlPath, 'agent.sh'), '#!/bin/bash\necho original', 'utf8');

    await updateSandboxSubtaskScripts({
      saifctlPath,
      gateScript: '#!/bin/bash\necho gate',
    });

    expect(await readUtf8(join(saifctlPath, 'gate.sh'))).toBe('#!/bin/bash\necho gate');
    expect(await readUtf8(join(saifctlPath, 'agent.sh'))).toBe('#!/bin/bash\necho original');
  });

  it('writes both gate.sh and agent.sh when agentScript is provided', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    const saifctlPath = join(base, 'saifctl');
    await mkdir(saifctlPath, { recursive: true });

    await updateSandboxSubtaskScripts({
      saifctlPath,
      gateScript: '#!/bin/bash\necho gate2',
      agentScript: '#!/bin/bash\necho agent2',
    });

    expect(await readUtf8(join(saifctlPath, 'gate.sh'))).toBe('#!/bin/bash\necho gate2');
    expect(await readUtf8(join(saifctlPath, 'agent.sh'))).toBe('#!/bin/bash\necho agent2');
  });
});

describe('prepareSubtaskSignalDir', () => {
  let base: string;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('creates .saifctl under code/ when missing', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code'), { recursive: true });

    await prepareSubtaskSignalDir(base);

    expect(await pathExists(join(base, 'code', '.saifctl'))).toBe(true);
  });

  it('removes stale signal files when present; does not throw when absent', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    const workspace = join(base, 'code');
    await mkdir(join(workspace, '.saifctl'), { recursive: true });
    await writeFile(subtaskDonePath(workspace), '0', 'utf8');
    await writeFile(subtaskExitPath(workspace), '', 'utf8');
    await writeFile(subtaskNextPath(workspace), 'x', 'utf8');
    await writeFile(subtaskRetriesPath(workspace), '3', 'utf8');

    await prepareSubtaskSignalDir(base);

    expect(await pathExists(subtaskDonePath(workspace))).toBe(false);
    expect(await pathExists(subtaskExitPath(workspace))).toBe(false);
    expect(await pathExists(subtaskNextPath(workspace))).toBe(false);
    expect(await pathExists(subtaskRetriesPath(workspace))).toBe(false);
  });
});

describe('writeSubtaskNextPrompt', () => {
  let base: string;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('writes exact content and creates parent dirs', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code'), { recursive: true });

    await writeSubtaskNextPrompt(base, 'next task body\nline2');

    const p = subtaskNextPath(join(base, 'code'));
    expect(await readUtf8(p)).toBe('next task body\nline2');
  });
});

describe('writeSubtaskRetriesOverride', () => {
  let base: string;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('writes stringified integer', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code'), { recursive: true });

    await writeSubtaskRetriesOverride(base, 7);

    expect(await readUtf8(subtaskRetriesPath(join(base, 'code')))).toBe('7');
  });
});

describe('writeSubtaskExitSignal', () => {
  let base: string;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('creates exit marker file', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code'), { recursive: true });

    await writeSubtaskExitSignal(base);

    const p = subtaskExitPath(join(base, 'code'));
    expect(await pathExists(p)).toBe(true);
    expect(await readUtf8(p)).toBe('');
  });
});

describe('pollSubtaskDone', () => {
  let base: string;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('resolves with exitCode 0 when file contains 0', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code', '.saifctl'), { recursive: true });
    const donePath = subtaskDonePath(join(base, 'code'));
    const ac = new AbortController();

    setTimeout(() => {
      void writeFile(donePath, '0', 'utf8');
    }, 30);

    const result = await pollSubtaskDone(base, ac.signal, 20);
    expect(result).toEqual({ exitCode: 0 });
    expect(await pathExists(donePath)).toBe(false);
  });

  it('resolves with exitCode 1 when file contains 1', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code', '.saifctl'), { recursive: true });
    const donePath = subtaskDonePath(join(base, 'code'));
    const ac = new AbortController();

    setTimeout(() => {
      void writeFile(donePath, '1', 'utf8');
    }, 30);

    const result = await pollSubtaskDone(base, ac.signal, 20);
    expect(result).toEqual({ exitCode: 1 });
    expect(await pathExists(donePath)).toBe(false);
  });

  it('resolves with exitCode 1 for non-integer content', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code', '.saifctl'), { recursive: true });
    const donePath = subtaskDonePath(join(base, 'code'));
    const ac = new AbortController();

    setTimeout(() => {
      void writeFile(donePath, 'not-a-number', 'utf8');
    }, 30);

    const result = await pollSubtaskDone(base, ac.signal, 20);
    expect(result).toEqual({ exitCode: 1 });
  });

  it('rejects when signal aborted before file appears', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code'), { recursive: true });
    const ac = new AbortController();

    const p = pollSubtaskDone(base, ac.signal, 20);
    ac.abort();

    await expect(p).rejects.toThrow(/aborted/);
  });

  it('rejects immediately when signal already aborted at call time', async () => {
    base = await mkdtemp(join(tmpdir(), 'saif-subtask-'));
    await mkdir(join(base, 'code'), { recursive: true });
    const ac = new AbortController();
    ac.abort();

    await expect(pollSubtaskDone(base, ac.signal, 20)).rejects.toThrow(/already aborted/);
  });
});
