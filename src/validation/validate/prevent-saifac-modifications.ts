import { execSync } from 'node:child_process';

export default async function preventSpecModifications() {
  let branchName = '';
  try {
    branchName = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
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
    statusOutput = execSync('git status --porcelain', { encoding: 'utf-8' });
  } catch {
    return;
  }

  const lines = statusOutput.split('\n').filter((line) => line.trim().length > 0);

  // If any uncommitted change touches the saifac/ directory
  const saifModifications = lines.filter((line) => line.includes('saifac/'));

  if (saifModifications.length > 0) {
    console.error(
      '❌ CRITICAL SECURITY BREACH: The Coder sidecar attempted to modify files in the saifac/ directory.',
    );
    console.error('   Uncommitted changes detected in saifac/:');
    for (const file of saifModifications) {
      console.error(`     - ${file.trim()}`);
    }
    console.error(
      '   Hint: The saifac/ directory contains authoritative ground-truth constraints and is strictly READ-ONLY for AI workers.',
    );
    console.error(
      '   You must implement the logic in src/ or scripts/ to satisfy the saifac, not modify the saifac themselves.',
    );
    throw new Error('AI Agent attempted to modify read-only saifac/ directory.');
  }
}
