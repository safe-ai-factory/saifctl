/* eslint-disable */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { execSidecar } from '../helpers.js';

describe('dummy.md File Structure', () => {
  it('tc-dummy-001: dummy.md exists at the project root', async () => {
    const { exitCode, stderr } = await execSidecar('test', ['-f', 'dummy.md']);
    expect(exitCode, `dummy.md not found at project root: ${stderr}`).toBe(0);
  });
});
