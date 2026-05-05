/* eslint-disable */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { execSidecar } from '../helpers.js';

describe('dummy.md Negative Cases (hidden)', () => {
  it('tc-dummy-011: filename is lowercase (no Dummy.md / DUMMY.MD)', async () => {
    const { stdout, exitCode } = await execSidecar('sh', [
      '-c',
      'ls -1 | grep -i "^dummy\\.md$" || true',
    ]);
    expect(exitCode).toBe(0);
    const matches = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(matches, `expected exactly one entry, got: ${matches.join(', ')}`).toHaveLength(1);
    expect(matches[0]).toBe('dummy.md');
  });
});
