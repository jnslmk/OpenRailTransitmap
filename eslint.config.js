// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.work/**', 'public/**', 'e2e/node_modules/**'],
  },
  js.configs.recommended,
  {
    // Type-aware rules only for the files covered by the root tsconfig.json
    // project (src, shared, pipeline, types, vite.config.ts). e2e/ is a
    // separate npm project with no tsconfig of its own, so it stays JS-only.
    files: ['src/**/*.ts', 'shared/**/*.ts', 'pipeline/**/*.ts', 'types/**/*.ts', 'vite.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
  {
    // node:test tests call `test(name, fn)` at the top level and rely on the
    // runner to track the returned promise; awaiting each call individually
    // would just serialise tests that don't need it.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // A Node driver script whose arrow functions are also handed to
    // page.evaluate() and run in the browser, so both global sets apply.
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
      globals: { ...globals.node, ...globals.browser },
    },
  },
  prettier,
);
