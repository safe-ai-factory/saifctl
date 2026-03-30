import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveCliInvocation } from './binaryResolver';

async function makeTempRoot(): Promise<string> {
  const base = join(
    tmpdir(),
    `saifctl-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(base, { recursive: true });
  return base;
}

describe('resolveCliInvocation', () => {
  it('returns trimmed user override when set', async () => {
    expect(
      await resolveCliInvocation({ cwd: '/any/path', userBinaryPath: '  /opt/saifctl  ' }),
    ).toBe('/opt/saifctl');
    expect(
      await resolveCliInvocation({ cwd: '/any/path', userBinaryPath: 'pnpm exec saifctl' }),
    ).toBe('pnpm exec saifctl');
  });

  it('falls back to saifctl when no local node_modules/.bin/saifctl', async () => {
    const root = await makeTempRoot();
    try {
      expect(await resolveCliInvocation({ cwd: root, userBinaryPath: '' })).toBe('saifctl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses absolute bin path for npm when node_modules/.bin/saifctl exists at cwd', async () => {
    const root = await makeTempRoot();
    try {
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
      const binDir = join(root, 'node_modules', '.bin');
      if (process.platform === 'win32') {
        await writeFile(join(binDir, 'saifctl.cmd'), '@echo off\n');
      } else {
        await writeFile(join(binDir, 'saifctl'), '#!/bin/sh\necho ok\n');
      }
      await writeFile(join(root, 'package-lock.json'), '{}');
      const resolved = await resolveCliInvocation({ cwd: root, userBinaryPath: '' });
      expect(resolved).toContain('node_modules');
      expect(resolved).toMatch(/saifctl(\.cmd)?$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds local bin in a parent directory when cwd is nested', async () => {
    const root = await makeTempRoot();
    try {
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
      const binDir = join(root, 'node_modules', '.bin');
      if (process.platform === 'win32') {
        await writeFile(join(binDir, 'saifctl.cmd'), '@echo off\n');
      } else {
        await writeFile(join(binDir, 'saifctl'), '#!/bin/sh\n');
      }
      await writeFile(join(root, 'package-lock.json'), '{}');
      const nestedCwd = join(root, 'packages', 'app');
      await mkdir(nestedCwd, { recursive: true });
      const resolved = await resolveCliInvocation({ cwd: nestedCwd, userBinaryPath: '' });
      expect(resolved).toContain('node_modules');
      expect(resolved).toMatch(/saifctl(\.cmd)?$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses pnpm exec when pnpm-lock.yaml is present and local bin exists', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await makeTempRoot();
    try {
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(root, 'node_modules', '.bin', 'saifctl'), '#!/bin/sh\n');
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      expect(await resolveCliInvocation({ cwd: root, userBinaryPath: '' })).toBe(
        'pnpm exec saifctl',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses yarn saifctl when yarn.lock is present and local bin exists', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await makeTempRoot();
    try {
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(root, 'node_modules', '.bin', 'saifctl'), '#!/bin/sh\n');
      await writeFile(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      expect(await resolveCliInvocation({ cwd: root, userBinaryPath: '' })).toBe('yarn saifctl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
