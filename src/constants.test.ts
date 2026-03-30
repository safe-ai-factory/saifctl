import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSaifctlPackageVersion, getSaifctlRoot } from './constants.js';
import { pathExists } from './utils/io.js';

describe('getSaifctlRoot', () => {
  it('returns an absolute path that contains package.json and default Cedar policy', async () => {
    const root = getSaifctlRoot();
    expect(root).toMatch(/^\/.+/); // absolute path
    expect(await pathExists(join(root, 'package.json'))).toBe(true);
    expect(await pathExists(join(root, 'src', 'orchestrator', 'policies', 'default.cedar'))).toBe(
      true,
    );
  });
});

describe('getSaifctlPackageVersion', () => {
  it('matches package.json version field', () => {
    const expected = JSON.parse(readFileSync(join(getSaifctlRoot(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(getSaifctlPackageVersion()).toBe(expected.version);
  });
});
