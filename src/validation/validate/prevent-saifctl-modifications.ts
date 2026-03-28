import { consola } from '../../logger.js';
import { spawnCapture } from '../../utils/io.js';

export default async function preventSpecModifications() {
  let branchName = '';
  try {
    branchName = (
      await spawnCapture({
        command: 'git',
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        cwd: process.cwd(),
      })
    ).trim();
  } catch {
    return; // Not a git repo
  }

  // Only enforce this tamper-proof constraint on AI Agent branches
  if (!branchName.startsWith('crew/')) {
    return;
  }

  let statusOutput = '';
  try {
    // The agent works in a fresh git worktree and its changes are uncommitted.
    // Any modified, added, or deleted files will appear in porcelain status.
    statusOutput = await spawnCapture({
      command: 'git',
      args: ['status', '--porcelain'],
      cwd: process.cwd(),
    });
  } catch {
    return;
  }

  const lines = statusOutput.split('\n').filter((line) => line.trim().length > 0);

  // If any uncommitted change touches the saifctl/ directory
  const saifModifications = lines.filter((line) => line.includes('saifctl/'));

  if (saifModifications.length > 0) {
    consola.error(
      '❌ CRITICAL SECURITY BREACH: The Coder sidecar attempted to modify files in the saifctl/ directory.',
    );
    consola.error('   Uncommitted changes detected in saifctl/:');
    for (const file of saifModifications) {
      consola.error(`     - ${file.trim()}`);
    }
    consola.error(
      '   Hint: The saifctl/ directory contains authoritative ground-truth constraints and is strictly READ-ONLY for AI workers.',
    );
    consola.error(
      '   You must implement the logic in src/ or scripts/ to satisfy the saifctl, not modify the saifctl themselves.',
    );
    throw new Error('AI Agent attempted to modify read-only saifctl/ directory.');
  }
}
