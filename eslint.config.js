import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    ignores: ['.aws-sam/**', 'node_modules/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
