import { describe, expect, it } from 'vitest';

import { chatTabDisplayName, runIdShortToken } from './chatTabLabels';

describe('runIdShortToken', () => {
  it('uses trailing alphanumeric slice', () => {
    expect(runIdShortToken('aaxktkw1re', 7)).toBe('ktkw1re');
  });

  it('returns full alnum when shorter than len', () => {
    expect(runIdShortToken('eed5lz6', 7)).toBe('eed5lz6');
  });
});

describe('chatTabDisplayName', () => {
  it('returns plain name when no collision', () => {
    const tabs = [{ runId: 'a1', featureName: 'dummy' }];
    expect(chatTabDisplayName(tabs, tabs[0]!)).toBe('dummy');
  });

  it('adds short run id suffix when two tabs share feature name', () => {
    const tabs = [
      { runId: 'aaxktkw1re', featureName: 'dummy' },
      { runId: 'preed5lz6', featureName: 'dummy' },
    ];
    const a = chatTabDisplayName(tabs, tabs[0]!);
    const b = chatTabDisplayName(tabs, tabs[1]!);
    expect(a).toContain('dummy');
    expect(b).toContain('dummy');
    expect(a).toMatch(/dummy \(ktkw1re\)$/);
    expect(b).toMatch(/dummy \(eed5lz6\)$/);
    expect(a).not.toBe(b);
  });

  it('treats same name with different casing as collision', () => {
    const tabs = [
      { runId: 'r1', featureName: 'Dummy' },
      { runId: 'r2', featureName: 'dummy' },
    ];
    expect(chatTabDisplayName(tabs, tabs[0]!)).toMatch(/Dummy \(r1\)$/);
    expect(chatTabDisplayName(tabs, tabs[1]!)).toMatch(/dummy \(r2\)$/);
  });

  it('does not group tabs with empty feature name', () => {
    const tabs = [
      { runId: 'only-alnum-aaaaaaa1', featureName: '' },
      { runId: 'only-alnum-bbbbbbb2', featureName: '' },
    ];
    expect(chatTabDisplayName(tabs, tabs[0]!)).toBe('only-alnum-aaaaaaa1');
    expect(chatTabDisplayName(tabs, tabs[1]!)).toBe('only-alnum-bbbbbbb2');
  });
});
