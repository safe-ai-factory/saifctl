/**
 * Hatchet client — opt-in for Phase 1.
 *
 * Returns a configured HatchetClient when HATCHET_CLIENT_TOKEN is set, or null
 * when it is not. Callers that receive null fall back to the existing in-process
 * orchestrator loop, so there is zero regression for users who have not yet set
 * up a Hatchet server.
 *
 * Usage:
 *   const hatchet = getHatchetClient();
 *   if (hatchet) { // use Hatchet path } else { // use existing loop }
 */

import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/client/client.js';

export type { HatchetClient };

let _cachedClient: HatchetClient | null | undefined = undefined;

/**
 * Returns a configured Hatchet client if HATCHET_CLIENT_TOKEN is set, otherwise null.
 * The result is memoized for the lifetime of the process.
 */
export function getHatchetClient(): HatchetClient | null {
  if (_cachedClient !== undefined) return _cachedClient;

  const token = process.env.HATCHET_CLIENT_TOKEN;
  if (!token) {
    _cachedClient = null;
    return null;
  }

  _cachedClient = HatchetClient.init();
  return _cachedClient;
}

/** Reset the cached client (for testing). */
export function _resetHatchetClient(): void {
  _cachedClient = undefined;
}
