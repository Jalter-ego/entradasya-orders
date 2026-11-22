import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // tests/integration: suite opcional con Postgres, fuera del pipeline.
  { ignores: ['dist/', 'coverage/', 'reports/', 'node_modules/', 'tests/integration/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Express declara los tipos de Request con `namespace` (declaration merging).
    files: ['src/types/**/*.d.ts'],
    rules: { '@typescript-eslint/no-namespace': 'off' },
  },
);
