// @ts-check
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    // Main process, preload, helpers and tests run in Node (CommonJS).
    files: ['main.js', 'preload.js', 'lib/**/*.js', 'test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // The renderer is a plain browser script; marked and DOMPurify are loaded
    // as globals by index.html.
    files: ['src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, marked: 'readonly', DOMPurify: 'readonly' },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
