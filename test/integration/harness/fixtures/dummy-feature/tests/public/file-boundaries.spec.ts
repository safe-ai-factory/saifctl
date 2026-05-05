/* eslint-disable */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { execSidecar } from '../helpers.js';

describe('dummy.md File Boundaries', () => {
  it('tc-dummy-009: file is strictly less than 50 lines', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('wc', ['-l', 'dummy.md']);
    expect(exitCode, `Failed to read dummy.md line count: ${stderr}`).toBe(0);
    const lineCount = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    expect(Number.isFinite(lineCount), `wc output was not parseable: ${stdout}`).toBe(true);
    expect(lineCount).toBeLessThan(50);
  });
});
