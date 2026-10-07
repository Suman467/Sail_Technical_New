// Configures the project's TypeScript lint rules.
// The rules stay small so the framework remains easy to read.
import eslint from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  eslint.configs.recommended,
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        process: 'readonly',
        require: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: tsPlugin.configs.recommended.rules,
  },
  {
    ignores: ['node_modules/**', 'reports/**', 'test-results/**', 'playwright/.auth/**'],
  },
];
