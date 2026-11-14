'use strict';

// Shared lint rules. Run `npm run lint`; formatting is handled by Prettier (`npm run format`).
const js = require('@eslint/js');
const globals = require('globals');

const unused = [
  'warn',
  { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
];

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': unused, 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // Browser scripts share the `api` helper defined in public/js/api.js.
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, api: 'readonly' } },
    rules: { 'no-unused-vars': unused, 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    files: ['public/js/api.js'],
    languageOptions: { globals: { api: 'off' } },
    rules: { 'no-unused-vars': 'off' },
  },
];
