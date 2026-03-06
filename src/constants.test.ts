import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSaifRoot } from './constants.js';

describe('getSaifRoot', () => {
  it('returns an absolute path that contains package.json and leash-policy.cedar', () => {
    const root = getSaifRoot();
    expect(root).toMatch(/^\/.+/); // absolute path
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'src', 'orchestrator', 'leash-policy.cedar'))).toBe(true);
  });
});
