/**
 * Shotgun designer profile.
 *
 * Runs `shotgun-sh` to generate a full feature specification:
 * plan.md, specification.md, research.md, tasks.md.
 *
 * Environment variables:
 *   SHOTGUN_PYTHON   — Path to the Python binary that has shotgun-sh installed
 *                      (default: "python"). Example: SHOTGUN_PYTHON=$(uv run which python)
 *
 * The profile treats the `indexerTool` as unused — Shotgun manages its own codebase
 * querying internally (Context7 integration is configured via `saif init`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runShotgunCli } from '../../indexer-profiles/shotgun/shotgun.js';
import type { DesignerBaseOpts, DesignerProfile, DesignerRunOpts } from '../types.js';

const REQUIRED_FILES = ['plan.md', 'research.md', 'specification.md', 'tasks.md'] as const;

export const shotgunDesignerProfile: DesignerProfile = {
  id: 'shotgun',
  displayName: 'Shotgun',

  // We assume that shotgun designer has run when the required files are present.
  hasRun({ cwd, featName, openspecDir }: DesignerBaseOpts): boolean {
    const changeDir = resolve(cwd, openspecDir, 'changes', featName);
    return REQUIRED_FILES.every((f) => existsSync(resolve(changeDir, f)));
  },

  // Calls shotgun-sh to generate the spec files.
  run({ cwd, featName, openspecDir, model, prompt }: DesignerRunOpts): void {
    const specDir = `${openspecDir}/changes/${featName}`;
    const proposalPath = resolve(cwd, openspecDir, 'changes', featName, 'proposal.md');

    const proposalPrompt =
      prompt ??
      (existsSync(proposalPath)
        ? `Based on the following proposal, run the full research, specify, plan, and tasks flow:\n\n${readFileSync(proposalPath, 'utf8')}`
        : 'Run the full research, specify, plan, and tasks flow for this change.');

    const runArgs = ['-n', proposalPrompt];
    if (model?.trim()) runArgs.splice(0, 0, '--model', model.trim());

    runShotgunCli(['--spec-dir', specDir, 'run', ...runArgs], {
      projectDir: cwd,
      // Shotgun needs these environment variables to stream the output to the console.
      env: { PYTHONUNBUFFERED: '1', SHOTGUN_LOGGING_TO_CONSOLE: '1' },
      printCmd: true,
    });
  },
};
