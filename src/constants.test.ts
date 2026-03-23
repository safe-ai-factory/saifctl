import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSaifRoot } from './constants.js';
import { pathExists } from './utils/io.js';

describe('getSaifRoot', () => {
  it('returns an absolute path that contains package.json and default Cedar policy', async () => {
    const root = getSaifRoot();
    expect(root).toMatch(/^\/.+/); // absolute path
    expect(await pathExists(join(root, 'package.json'))).toBe(true);
    expect(
      await pathExists(join(root, 'src', 'orchestrator', 'policies', 'leash-policy.cedar')),
    ).toBe(true);
  });
});
