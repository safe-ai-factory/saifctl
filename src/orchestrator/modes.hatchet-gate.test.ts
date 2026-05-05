/**
 * Tests for {@link assertHatchetReady} — the v0.1.0 Hatchet experimental gate
 * (per release-readiness Decision D-04).
 *
 * The gate is a pure function over `isLocal` and the
 * `SAIFCTL_EXPERIMENTAL_HATCHET` env var, so each case is one assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertHatchetReady } from './modes.js';

describe('assertHatchetReady', () => {
  const original = process.env.SAIFCTL_EXPERIMENTAL_HATCHET;

  beforeEach(() => {
    delete process.env.SAIFCTL_EXPERIMENTAL_HATCHET;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SAIFCTL_EXPERIMENTAL_HATCHET;
    } else {
      process.env.SAIFCTL_EXPERIMENTAL_HATCHET = original;
    }
  });

  it('does not throw in local mode (isLocal=true)', () => {
    expect(() => assertHatchetReady(true)).not.toThrow();
  });

  it('does not throw in local mode even when the experimental flag is set', () => {
    process.env.SAIFCTL_EXPERIMENTAL_HATCHET = '1';
    expect(() => assertHatchetReady(true)).not.toThrow();
  });

  it('throws when isLocal=false and SAIFCTL_EXPERIMENTAL_HATCHET is unset', () => {
    expect(() => assertHatchetReady(false)).toThrowError(/not yet available in v0\.1\.0/);
  });

  it('throws when isLocal=false and the flag is any non-"1" value', () => {
    process.env.SAIFCTL_EXPERIMENTAL_HATCHET = 'true';
    expect(() => assertHatchetReady(false)).toThrowError(/not yet available in v0\.1\.0/);

    process.env.SAIFCTL_EXPERIMENTAL_HATCHET = '0';
    expect(() => assertHatchetReady(false)).toThrowError(/not yet available in v0\.1\.0/);

    process.env.SAIFCTL_EXPERIMENTAL_HATCHET = '';
    expect(() => assertHatchetReady(false)).toThrowError(/not yet available in v0\.1\.0/);
  });

  it('does not throw when isLocal=false and SAIFCTL_EXPERIMENTAL_HATCHET=1', () => {
    process.env.SAIFCTL_EXPERIMENTAL_HATCHET = '1';
    expect(() => assertHatchetReady(false)).not.toThrow();
  });

  it('error mentions both fallback options the user has', () => {
    let err: Error | undefined;
    try {
      assertHatchetReady(false);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/HATCHET_CLIENT_TOKEN/);
    expect(err!.message).toMatch(/SAIFCTL_EXPERIMENTAL_HATCHET=1/);
  });
});
