import path from 'node:path';
import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginImport from 'eslint-plugin-import';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

const agentsRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(
  // Ignores must be in a standalone config object for flat config to apply them
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.venv/**',
      'test/integration/harness/fixtures/**',
    ],
  },
  // 3rd party configs
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Project config
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: agentsRoot,
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
      },
    },
    // Plugins enable formatting code when running `eslint --fix`
    plugins: {
      import: eslintPluginImport,
      'simple-import-sort': simpleImportSort,
      prettier: eslintPluginPrettier,
    },
    rules: {
      // prettier
      'prettier/prettier': 'error',
      // imports
      'import/first': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      // typescript
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Other
      'max-params': ['error', 2],
      'no-duplicate-imports': 'error',
    },
  },
  // Test files override rules
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'max-params': 'off',
    },
  },
  // 3rd party configs that MUST be last
  eslintConfigPrettier,
);
