/**
 * Build the initial agent task prompt from feature plan.md + specification.md.
 * Extracted as a shared utility so both the Hatchet workflow and the existing
 * in-process loop can build the same prompt.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Feature } from '../../specs/discover.js';

interface BuildInitialTaskOpts {
  feature: Feature;
  saifDir: string;
}

export function buildInitialTaskForWorkflow(opts: BuildInitialTaskOpts): string {
  const { feature, saifDir } = opts;
  const planPath = join(feature.absolutePath, 'plan.md');
  const specPath = join(feature.absolutePath, 'specification.md');

  const parts = [
    `Implement the feature '${feature.name}' as described in the plan below.`,
    `Write code in the /workspace directory. Do NOT modify files in the /${saifDir}/ directory.`,
    'When complete, ensure the code compiles and passes linting.',
  ];

  if (existsSync(planPath)) {
    parts.push('', '## Plan', '', readFileSync(planPath, 'utf8'));
  }

  if (existsSync(specPath)) {
    parts.push('', '## Specification', '', readFileSync(specPath, 'utf8'));
  }

  return parts.join('\n');
}
