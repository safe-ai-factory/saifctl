/**
 * Git assertions for integration scenarios.
 *
 * Reads the project repo (the `mkdtemp` host repo, not the sandbox) so tests
 * see what the orchestrator's `applyPatchToHost` produced.
 */
import { git } from '../../../../src/utils/git.js';

/**
 * Number of commits reachable from `head` but not from `base`. Used to verify
 * the orchestrator actually committed work to the produced feature branch
 * (rather than emitting an empty branch with no agent commits).
 */
export async function commitsAheadOf(opts: {
  projectDir: string;
  base: string;
  head: string;
}): Promise<number> {
  const out = await git({
    cwd: opts.projectDir,
    args: ['rev-list', '--count', `${opts.base}..${opts.head}`],
  });
  const n = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`commitsAheadOf: unexpected rev-list output: ${out}`);
  }
  return n;
}

export async function listBranches(projectDir: string): Promise<string[]> {
  const out = await git({
    cwd: projectDir,
    args: ['branch', '--list', '--format=%(refname:short)'],
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ReadFileFromRefOpts {
  projectDir: string;
  ref: string;
  relPath: string;
}

export async function readFileFromRef(opts: ReadFileFromRefOpts): Promise<string | null> {
  try {
    return await git({ cwd: opts.projectDir, args: ['show', `${opts.ref}:${opts.relPath}`] });
  } catch {
    return null;
  }
}
