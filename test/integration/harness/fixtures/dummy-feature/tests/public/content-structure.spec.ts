/* eslint-disable */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { execSidecar } from '../helpers.js';

describe('dummy.md Content Structure', () => {
  it('tc-dummy-002: Presence of the correct H1 title', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);

    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    expect(stdout).toContain('# Dummy');
  });

  it('tc-dummy-003: Presence of the Purpose section', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);

    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    expect(stdout).toMatch(/#+\s+Purpose/i);
  });

  it('tc-dummy-004: Presence of the Structure section', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);

    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    expect(stdout).toMatch(/#+\s+Structure/i);
  });

  it('tc-dummy-005: Presence of the Next Steps section', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);

    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    expect(stdout).toMatch(/#+\s+Next Steps/i);
  });
});
