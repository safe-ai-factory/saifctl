import { describe, expect, it } from 'vitest';

import { hasAnyKnownLlmKeyInEnv, parseDotEnv } from './envKeys';

describe('parseDotEnv', () => {
  it('parses simple pairs', () => {
    expect(parseDotEnv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and empty lines', () => {
    expect(
      parseDotEnv(`
# comment
ANTHROPIC_API_KEY=sk-ant

`),
    ).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' });
  });

  it('supports export prefix and double quotes', () => {
    expect(parseDotEnv('export OPENAI_API_KEY="sk-abc"')).toEqual({
      OPENAI_API_KEY: 'sk-abc',
    });
  });

  it('supports single quotes', () => {
    expect(parseDotEnv("X='y z'")).toEqual({ X: 'y z' });
  });
});

describe('hasAnyKnownLlmKeyInEnv', () => {
  it('returns false when no known keys set', () => {
    expect(hasAnyKnownLlmKeyInEnv({})).toBe(false);
    expect(hasAnyKnownLlmKeyInEnv({ OTHER: 'x' })).toBe(false);
    expect(hasAnyKnownLlmKeyInEnv({ ANTHROPIC_API_KEY: '' })).toBe(false);
    expect(hasAnyKnownLlmKeyInEnv({ ANTHROPIC_API_KEY: '   ' })).toBe(false);
  });

  it('returns true when a known key is non-empty', () => {
    expect(hasAnyKnownLlmKeyInEnv({ ANTHROPIC_API_KEY: 'sk-ant' })).toBe(true);
    expect(hasAnyKnownLlmKeyInEnv({ HF_TOKEN: 'hf_xxx' })).toBe(true);
  });
});
