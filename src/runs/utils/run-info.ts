/**
 * View model for `saifac run info` — JSON-safe snapshot without large blobs.
 */

import type { RunArtifact } from '../types.js';

/** Script body fields on {@link RunArtifact.config}; paths stay via *ScriptFile / testScriptFile. */
const SCRIPT_BODY_KEYS = [
  'gateScript',
  'startupScript',
  'agentInstallScript',
  'agentScript',
  'stageScript',
  'testScript',
] as const;

/**
 * Clone of the stored run suitable for terminal JSON: omits patch diffs and script bodies;
 * keeps `*ScriptFile` / `testScriptFile` paths only.
 */
export function toRunInfoJson(artifact: RunArtifact): Record<string, unknown> {
  const clone = structuredClone(artifact);
  delete clone.basePatchDiff;
  /** @ts-expect-error - runPatchDiff is not a property of RunArtifact */
  delete clone.runPatchDiff;

  for (const k of SCRIPT_BODY_KEYS) {
    delete clone.config[k];
  }

  return clone as unknown as Record<string, unknown>;
}
