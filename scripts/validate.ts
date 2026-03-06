#!/usr/bin/env tsx
import { defineCommand, runMain } from 'citty';

import { runValidation } from '../src/validation/validate/index.js';

const command = defineCommand({
  meta: {
    name: 'validate',
    description:
      'Validation runner — discovers and runs all validation scripts in src/engine/validate/. Exits with code 1 if any script throws.',
  },
  async run() {
    await runValidation();
  },
});

export default command; // Export for validation

// Allow running directly: tsx scripts/validate.ts
if (process.argv[1]?.endsWith('validate.ts') || process.argv[1]?.endsWith('validate.js')) {
  await runMain(command);
}
