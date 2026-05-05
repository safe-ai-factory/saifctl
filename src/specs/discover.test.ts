import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverFeatures, featureNameToSafeSlug, isGroupDir } from './discover.js';

const TEST_BASE = join(tmpdir(), `discover-features-${Date.now()}`);

async function createDir(relPath: string): Promise<string> {
  const full = join(TEST_BASE, relPath);
  await mkdir(full, { recursive: true });
  return full;
}

describe('discover-features', () => {
  afterEach(async () => {
    try {
      await rm(TEST_BASE, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('featureNameToSafeSlug', () => {
    it('leaves flat feature names unchanged', () => {
      expect(featureNameToSafeSlug('my-feat')).toBe('my-feat');
      expect(featureNameToSafeSlug('add-login')).toBe('add-login');
    });
    it('replaces / and strips () from nested feature names', () => {
      expect(featureNameToSafeSlug('(auth)/login')).toBe('auth-login');
      expect(featureNameToSafeSlug('(auth)/logout')).toBe('auth-logout');
      expect(featureNameToSafeSlug('(core)/(user)/profile')).toBe('core-user-profile');
    });
    it('produces Docker- and filesystem-safe slugs', () => {
      const slug = featureNameToSafeSlug('(auth)/router');
      expect(slug).not.toMatch(/[()/]/);
      expect(slug).toBe('auth-router');
    });
  });

  describe('isGroupDir', () => {
    it('returns true for (group) style names', () => {
      expect(isGroupDir('(auth)')).toBe(true);
      expect(isGroupDir('(core)')).toBe(true);
      expect(isGroupDir('(user)')).toBe(true);
    });
    it('returns false for normal dir names', () => {
      expect(isGroupDir('auth')).toBe(false);
      expect(isGroupDir('login')).toBe(false);
      expect(isGroupDir('my-feat')).toBe(false);
    });
    it('returns false for partial parens', () => {
      expect(isGroupDir('(auth')).toBe(false);
      expect(isGroupDir('auth)')).toBe(false);
    });
  });

  describe('discoverFeatures', () => {
    it('finds flat features', async () => {
      await mkdir(join(TEST_BASE, 'saifctl'), { recursive: true });
      await createDir('saifctl/features/my-feat');
      await createDir('saifctl/features/add-login');

      const map = await discoverFeatures(TEST_BASE, 'saifctl');
      expect(map.size).toBe(2);
      expect(map.get('my-feat')).toContain('my-feat');
      expect(map.get('add-login')).toContain('add-login');
    });

    it('finds features inside groups with path-based IDs', async () => {
      await mkdir(join(TEST_BASE, 'saifctl'), { recursive: true });
      await createDir('saifctl/features/(auth)/login');
      await createDir('saifctl/features/(auth)/logout');
      await createDir('saifctl/features/(core)/profile');

      const map = await discoverFeatures(TEST_BASE, 'saifctl');
      expect(map.size).toBe(3);
      expect(map.get('(auth)/login')).toContain('login');
      expect(map.get('(auth)/logout')).toContain('logout');
      expect(map.get('(core)/profile')).toContain('profile');
    });

    it('treats same leaf name in different groups as distinct features', async () => {
      await mkdir(join(TEST_BASE, 'saifctl'), { recursive: true });
      await createDir('saifctl/features/(auth)/router');
      await createDir('saifctl/features/(user)/router');

      const map = await discoverFeatures(TEST_BASE, 'saifctl');
      expect(map.size).toBe(2);
      expect(map.get('(auth)/router')).toBeDefined();
      expect(map.get('(user)/router')).toBeDefined();
    });

    it('includes all non-group dirs (path-based)', async () => {
      await mkdir(join(TEST_BASE, 'saifctl'), { recursive: true });
      await createDir('saifctl/features/valid-feat');
      await mkdir(join(TEST_BASE, 'saifctl', 'features', 'no-spec'), { recursive: true });

      const map = await discoverFeatures(TEST_BASE, 'saifctl');
      expect(map.size).toBe(2);
      expect(map.has('valid-feat')).toBe(true);
      expect(map.has('no-spec')).toBe(true);
    });

    it('scans saifctl/features', async () => {
      await mkdir(join(TEST_BASE, 'saifctl'), { recursive: true });
      await createDir('saifctl/features/feat-a');

      const map = await discoverFeatures(TEST_BASE, 'saifctl');
      expect(map.size).toBe(1);
      expect(map.get('feat-a')).toContain('feat-a');
    });

    it('skips _-prefixed dirs (reserved for worked examples / docs)', async () => {
      await mkdir(join(TEST_BASE, 'saifctl'), { recursive: true });
      await createDir('saifctl/features/real-feat');
      await createDir('saifctl/features/_phases-example');
      await createDir('saifctl/features/_template');

      const map = await discoverFeatures(TEST_BASE, 'saifctl');
      expect(map.size).toBe(1);
      expect(map.has('real-feat')).toBe(true);
      expect(map.has('_phases-example')).toBe(false);
      expect(map.has('_template')).toBe(false);
    });
  });
});
