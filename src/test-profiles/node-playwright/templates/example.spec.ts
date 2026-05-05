/* eslint-disable */
// @ts-nocheck
/**
 * Example test — a runnable starting point you EDIT IN PLACE.
 *
 * Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
 * design-tests`. Unlike helpers.ts / infra.spec.ts, this file is meant to
 * be edited: keep it as a working reference for the Playwright format, or
 * replace its contents with your real assertion. The scaffold skips this
 * file when it already exists; pass `--force` to overwrite.
 *
 * What this demonstrates:
 *   - Importing `baseUrl` from `./helpers.js`
 *   - Hitting the staging app over HTTP via Playwright
 *   - Asserting on response status
 *
 * If your project doesn't expose an HTTP service in the staging container,
 * delete this file and use `execSidecar` from helpers.ts instead (CLI-style
 * checks, like the node-vitest example).
 */
import { test, expect } from '@playwright/test';

import { baseUrl } from './helpers.js';

test('example: staging app responds at /', async ({ request }) => {
  const res = await request.get(baseUrl());
  expect(res.ok(), `staging app not reachable: ${res.status()}`).toBeTruthy();
});
