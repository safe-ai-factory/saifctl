/**
 * Hatchet client — remove server or in-memory mock
 *
 * - When `HATCHET_CLIENT_TOKEN` is set → real `HatchetClient` (remote server).
 * - When it is not set → `LocalHatchetRunner` (same workflow code path, in-process).
 *
 * Usage:
 *   const { hatchet, isLocal } = getHatchetClient();
 */

import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/client/client.js';

import { createLocalHatchetRunner, type HatchetLike } from './utils/local.js';

export type { HatchetClient, HatchetLike };

interface HatchetPayload {
  hatchet: HatchetLike;
  isLocal: boolean;
}

let _cachedClient: HatchetPayload | undefined = undefined;

/**
 * Returns a Hatchet-compatible client. Memoized for the process lifetime.
 */
export function getHatchetClient(): HatchetPayload {
  if (_cachedClient !== undefined) return _cachedClient;

  const token = process.env.HATCHET_CLIENT_TOKEN;
  if (!token) {
    _cachedClient = { hatchet: createLocalHatchetRunner(), isLocal: true };
    return _cachedClient;
  }

  // Cast: HatchetClient satisfies HatchetLike at runtime (same .workflow / .worker / .run
  // surface), but its SDK WorkflowDeclaration type is structurally incompatible with ours.
  // The cast is safe because feat-run.workflow.ts only calls methods present in both.
  _cachedClient = { hatchet: HatchetClient.init() as unknown as HatchetLike, isLocal: false };
  return _cachedClient;
}
