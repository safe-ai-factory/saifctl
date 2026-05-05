import { describe, expect, it } from 'vitest';

import { filterUnifiedDiffByPrefix } from './sandbox-extract.js';

describe('filterUnifiedDiffByPrefix', () => {
  it('keeps sections under includePrefix and drops excludePrefix', () => {
    const patch = [
      'diff --git a/saifctl/features/keep/a.md b/saifctl/features/keep/a.md',
      '--- a/saifctl/features/keep/a.md',
      '+++ b/saifctl/features/keep/a.md',
      '+x',
      '',
      'diff --git a/saifctl/features/exclude/b.md b/saifctl/features/exclude/b.md',
      '--- a/saifctl/features/exclude/b.md',
      '+++ b/saifctl/features/exclude/b.md',
      '+y',
      '',
      'diff --git a/other/c.md b/other/c.md',
      '--- a/other/c.md',
      '+++ b/other/c.md',
      '+z',
    ].join('\n');

    const out = filterUnifiedDiffByPrefix({
      patch,
      includePrefix: 'saifctl/features/',
      excludePrefix: 'saifctl/features/exclude/',
    });

    expect(out).toContain('saifctl/features/keep/a.md');
    expect(out).not.toContain('saifctl/features/exclude/b.md');
    expect(out).not.toContain('other/c.md');
  });

  it('omits exclude when excludePrefix is empty', () => {
    const patch =
      'diff --git a/saifctl/features/a.md b/saifctl/features/a.md\n' +
      '--- a/saifctl/features/a.md\n' +
      '+++ b/saifctl/features/a.md\n';
    const out = filterUnifiedDiffByPrefix({
      patch,
      includePrefix: 'saifctl/features/',
      excludePrefix: '',
    });
    expect(out).toContain('saifctl/features/a.md');
  });

  it('filtering disjoint sub-patches then concatenating matches filtering the full patch', () => {
    const patch1 = 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n+a\n';
    const patch2 = 'diff --git a/docs/b.md b/docs/b.md\n--- a/docs/b.md\n+++ b/docs/b.md\n+b\n';
    const full = `${patch1}\n${patch2}`;
    const filteredFull = filterUnifiedDiffByPrefix({ patch: full, includePrefix: 'docs/' });
    const f1 = filterUnifiedDiffByPrefix({ patch: patch1, includePrefix: 'docs/' });
    const f2 = filterUnifiedDiffByPrefix({ patch: patch2, includePrefix: 'docs/' });
    expect(
      [f1, f2]
        .filter((s) => s.trim())
        .join('\n')
        .trim(),
    ).toBe(filteredFull.trim());
  });
});
