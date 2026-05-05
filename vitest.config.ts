import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'saifctl/**/tests/**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/__generated__/**',
      ],
      reporter: ['text', 'lcov'],
      // TODO - require 98% test coverage
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 35,
        statements: 40,
      },
    },
  },
});
