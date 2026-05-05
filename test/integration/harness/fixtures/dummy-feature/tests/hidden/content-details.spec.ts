/* eslint-disable */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { execSidecar } from '../helpers.js';

const sectionAfter = (body: string, heading: RegExp): string => {
  const lines = body.split('\n');
  const startIdx = lines.findIndex((l) => heading.test(l));
  if (startIdx === -1) return '';
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^#{1,6}\s+/.test(l));
  return (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n');
};

describe('dummy.md Content Details (hidden)', () => {
  it('tc-dummy-006: Purpose section explains placeholder role', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);
    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    const section = sectionAfter(stdout, /^#+\s+Purpose/i);
    expect(section).toMatch(/placeholder|scaffold|documentation pipeline/i);
  });

  it('tc-dummy-007: Structure section describes markdown conventions', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);
    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    const section = sectionAfter(stdout, /^#+\s+Structure/i);
    expect(section).toMatch(/convention|hierarchy|organization/i);
  });

  it('tc-dummy-008: Next Steps section provides replacement guidance', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);
    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    const section = sectionAfter(stdout, /^#+\s+Next Steps/i);
    expect(section).toMatch(/replace|placeholder/i);
  });
});
