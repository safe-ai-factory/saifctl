/**
 * View model for `saifctl run info` — JSON-safe snapshot without large blobs.
 */

import type { RunArtifact, RunCommit } from '../types.js';

/** Script body fields on {@link RunArtifact.config}; paths stay via *ScriptFile / testScriptFile. */
const SCRIPT_BODY_KEYS = [
  'gateScript',
  'startupScript',
  'agentInstallScript',
  'agentScript',
  'stageScript',
  'testScript',
  'cedarScript',
] as const;

/** Per-commit line in `run info` output (no unified diff). */
export interface RunCommitInfoRow {
  message: string;
  author?: string;
}

function runCommitsToInfoRows(commits: RunCommit[]): RunCommitInfoRow[] {
  return commits.map((c) => {
    const author = c.author?.trim();
    if (author) {
      return { message: c.message, author };
    }
    return { message: c.message };
  });
}

export type RunArtifactInfo = Omit<RunArtifact, 'basePatchDiff' | 'runCommits'> & {
  runCommits: RunCommitInfoRow[];
};

/**
 * Clone of the Run suitable for terminal JSON: omits patch diffs and script bodies;
 * keeps `*ScriptFile` / `testScriptFile` paths only.
 *
 * **`runCommits`** is replaced with **message + optional author** per entry (diffs omitted).
 */
export function toRunInfoJson(artifact: RunArtifact): RunArtifactInfo {
  const clone = structuredClone(artifact) as RunArtifactInfo;
  delete (clone as RunArtifact).basePatchDiff;
  const commits = artifact.runCommits ?? [];
  clone.runCommits = runCommitsToInfoRows(commits);

  const cfg = clone.config;
  for (const k of SCRIPT_BODY_KEYS) {
    delete cfg[k];
  }

  return clone;
}
