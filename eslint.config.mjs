// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The simulation must be deterministic: only the seeded RNG is allowed.
    files: ['packages/sim/src/**/*.ts', 'packages/ai/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng from @warsim/sim; the sim must be deterministic.' },
        { object: 'Date', property: 'now', message: 'No wall-clock time inside the simulation.' },
      ],
      'no-restricted-globals': ['error', { name: 'performance', message: 'No wall-clock time inside the simulation.' }],
    },
  },
);
