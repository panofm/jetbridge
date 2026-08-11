import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Node globals. Declared rather than pulled from a plugin — this is the whole list we use. */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  NodeJS: 'readonly',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/fixtures/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: nodeGlobals } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
