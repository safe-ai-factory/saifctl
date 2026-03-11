import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverFeatures, featureNameToSafeSlug, isGroupDir } from './discover.js';

const TEST_BASE = join(tmpdir(), `discover-features-${Date.now()}`);

function createDir(path: string) {
  const full = join(TEST_BASE, path);
  mkdirSync(full, { recursive: true });
  return full;
}

describe('discover-features', () => {
  afterEach(() => {
    try {
      rmSync(TEST_BASE, { recursive: true, force: true });
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
    it('finds flat features', () => {
      mkdirSync(join(TEST_BASE, 'saif'), { recursive: true });
      createDir('saif/features/my-feat');
      createDir('saif/features/add-login');

      const map = discoverFeatures(TEST_BASE, 'saif');
      expect(map.size).toBe(2);
      expect(map.get('my-feat')).toContain('my-feat');
      expect(map.get('add-login')).toContain('add-login');
    });

    it('finds features inside groups with path-based IDs', () => {
      mkdirSync(join(TEST_BASE, 'saif'), { recursive: true });
      createDir('saif/features/(auth)/login');
      createDir('saif/features/(auth)/logout');
      createDir('saif/features/(core)/profile');

      const map = discoverFeatures(TEST_BASE, 'saif');
      expect(map.size).toBe(3);
      expect(map.get('(auth)/login')).toContain('login');
      expect(map.get('(auth)/logout')).toContain('logout');
      expect(map.get('(core)/profile')).toContain('profile');
    });

    it('treats same leaf name in different groups as distinct features', () => {
      mkdirSync(join(TEST_BASE, 'saif'), { recursive: true });
      createDir('saif/features/(auth)/router');
      createDir('saif/features/(user)/router');

      const map = discoverFeatures(TEST_BASE, 'saif');
      expect(map.size).toBe(2);
      expect(map.get('(auth)/router')).toBeDefined();
      expect(map.get('(user)/router')).toBeDefined();
    });

    it('includes all non-group dirs (path-based)', () => {
      mkdirSync(join(TEST_BASE, 'saif'), { recursive: true });
      createDir('saif/features/valid-feat');
      mkdirSync(join(TEST_BASE, 'saif', 'features', 'no-spec'), { recursive: true });

      const map = discoverFeatures(TEST_BASE, 'saif');
      expect(map.size).toBe(2);
      expect(map.has('valid-feat')).toBe(true);
      expect(map.has('no-spec')).toBe(true);
    });

    it('scans saif/features', () => {
      mkdirSync(join(TEST_BASE, 'saif'), { recursive: true });
      createDir('saif/features/feat-a');

      const map = discoverFeatures(TEST_BASE, 'saif');
      expect(map.size).toBe(1);
      expect(map.get('feat-a')).toContain('feat-a');
    });
  });
});
