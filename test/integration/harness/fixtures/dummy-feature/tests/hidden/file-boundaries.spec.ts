/* eslint-disable */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { execSidecar } from '../helpers.js';

describe('dummy.md File Boundaries (hidden)', () => {
  it('tc-dummy-010: file ends with exactly one trailing newline', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);
    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    expect(stdout.length, 'file is empty').toBeGreaterThan(0);
    expect(stdout.endsWith('\n'), 'file should end with a newline').toBe(true);
    expect(stdout.endsWith('\n\n'), 'file should not end with multiple blank lines').toBe(false);
  });
});
