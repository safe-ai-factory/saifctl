#!/usr/bin/env tsx
import { defineCommand, runMain } from 'citty';

import { runCheck } from '../src/validation/index.js';

const command = defineCommand({
  meta: {
    name: 'check',
    description:
      'Run the check pipeline: Types, Lint, Format, Unit Tests, Custom Constraints. Used by CI and for local verification.',
  },
  args: {
    reporter: {
      type: 'string',
      description: 'Output format for agent consumption (e.g. "agent" for JSON PASSED/FAILED)',
    },
  },
  async run({ args }) {
    await runCheck({ reporter: args.reporter });
  },
});

export default command; // Export for validation

// Allow running directly: tsx scripts/check.ts [options]
if (process.argv[1]?.endsWith('check.ts') || process.argv[1]?.endsWith('check.js')) {
  await runMain(command);
}
