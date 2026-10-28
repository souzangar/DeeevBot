// @ts-check
// Lint rules for the TypeScript sources (doc/guides/developer-setup.md).
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** @type {(name: string) => { name: string, message: string }} */
const workerHasNo = (name) => ({
  name,
  message: 'src/ is bundled for the Workers runtime, which has no file system or processes.',
});

export default defineConfig(
  {
    // The kit's tooling and generated output are not application code.
    ignores: [
      'node_modules/',
      'dist/',
      'coverage/',
      '.wrangler/',
      '.claude/',
      'scripts/okf/',
      'selftest/',
      'selftest-okf/',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Critical invariant 6: nothing is logged except through the redacting
      // logger (src/privacy/, Phase 3).
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    // Unit tests run under node, never in the Worker bundle.
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'node:fs',
            'node:fs/promises',
            'fs',
            'fs/promises',
            'node:child_process',
            'child_process',
          ].map(workerHasNo),
        },
      ],
    },
  },
);
