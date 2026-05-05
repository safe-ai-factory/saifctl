/* eslint-disable */
// @ts-nocheck
/**
 * Example test — a runnable starting point you EDIT IN PLACE.
 *
 * Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
 * design-tests`. Unlike helpers.ts / infra.spec.ts, this file is meant to be
 * edited: keep it as a working reference for the test format, or replace its
 * contents with your real assertion. The scaffold skips this file when it
 * already exists; pass `--force` to overwrite.
 *
 * What this demonstrates:
 *   - Importing the shared transport from `./helpers.js`
 *   - Calling `execSidecar(cmd, args)` to run a command in the staging container
 *   - Asserting on `exitCode`, `stdout`, `stderr`
 *
 * Why it passes by default: every saifctl staging container ships a sidecar
 * that exposes the workspace shell, and `echo example-ok` is reliably present.
 * Replace this with whatever invariant you actually want gated.
 */
import { describe, expect, it } from 'vitest';

import { execSidecar } from './helpers.js';

describe('example', () => {
  it('runs a noop in the staging container and observes a clean exit', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('echo', ['example-ok']);
    expect(exitCode, `staging echo failed: ${stderr}`).toBe(0);
    expect(stdout.trim()).toBe('example-ok');
  });
});
