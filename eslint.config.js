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
      // logger, src/privacy/logger.ts (the one exception, below).
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
  {
    // The Node port's file-system readers (the MVP plan, section 2, "Node
    // port"): the migrations runner reads migrations/*.sql, the node:sqlite
    // adapters and the Node entry open the database file. The Worker
    // (src/worker.ts) never imports them; child processes stay forbidden.
    files: ['src/node.ts', 'src/db/node-*.ts', 'src/db/migrate.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['node:child_process', 'child_process'].map((name) => ({
            name,
            message: 'The application never starts a process.',
          })),
        },
      ],
    },
  },
  {
    // The redacting logger is the ONE file allowed to write to the console
    // (critical invariant 6, ADR 0005), and only through console.log and
    // console.error; no-console stays an error everywhere else, and
    // test/invariants/logger-redaction.test.ts fails if another file under
    // src/ touches the console.
    files: ['src/privacy/logger.ts'],
    rules: {
      'no-console': ['error', { allow: ['log', 'error'] }],
    },
  },
);
