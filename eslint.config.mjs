// Correctness lint only. It catches what `node --check` cannot: an identifier that is used
// but never defined or imported, and imports or variables that are no longer used.
// Formatting is deliberately not enforced here.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The helpers replace caught errors with fixed messages on purpose: a raw git or gh
      // error can carry a key path, a token or a private repository name.
      'preserve-caught-error': 'off',
    },
  },
];
