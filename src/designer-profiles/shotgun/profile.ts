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
 * querying internally (Context7 integration is configured via `saifac init`).
 */

import { join } from 'node:path';

import { runShotgunCli } from '../../indexer-profiles/shotgun/shotgun.js';
import { pathExists, readUtf8 } from '../../utils/io.js';
import type { DesignerBaseOpts, DesignerProfile, DesignerRunOpts } from '../types.js';

const REQUIRED_FILES = ['plan.md', 'research.md', 'specification.md', 'tasks.md'] as const;

export const shotgunDesignerProfile: DesignerProfile = {
  id: 'shotgun',
  displayName: 'Shotgun',

  async hasRun({ feature }: DesignerBaseOpts): Promise<boolean> {
    for (const f of REQUIRED_FILES) {
      if (!(await pathExists(join(feature.absolutePath, f)))) return false;
    }
    return true;
  },

  async run({ cwd, feature, model, prompt }: DesignerRunOpts): Promise<void> {
    const proposalPath = join(feature.absolutePath, 'proposal.md');

    const proposalPrompt =
      prompt ??
      ((await pathExists(proposalPath))
        ? `Based on the following proposal, run the full research, specify, plan, and tasks flow:\n\n${await readUtf8(proposalPath)}`
        : 'Run the full research, specify, plan, and tasks flow for this feature.');

    const runArgs = ['-n', proposalPrompt];
    if (model?.trim()) runArgs.splice(0, 0, '--model', model.trim());

    // Run `shotgun-sh --spec-dir <featureDir> run -n <proposalPrompt>`
    await runShotgunCli(['--spec-dir', feature.relativePath, 'run', ...runArgs], {
      projectDir: cwd,
      // Shotgun needs these environment variables to stream the output to the console.
      env: { PYTHONUNBUFFERED: '1', SHOTGUN_LOGGING_TO_CONSOLE: '1' },
      printCmd: true,
    });
  },
};
