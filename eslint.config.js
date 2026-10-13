import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Compiled with strict settings by scripts/verify-package.mjs instead: it imports the
      // built package, so it can only typecheck after a build.
      'scripts/typecheck-consumer.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    // The TypeScript side gets its globals from @types/node; these are listed by hand because
    // the ops scripts in scripts/ are plain JavaScript.
    languageOptions: {
      globals: { AbortController: 'readonly', console: 'readonly', process: 'readonly', setTimeout: 'readonly' },
    },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // dependency-cruiser can only see imports, and `process` is a global: this is the rule that
    // actually keeps the layers above the boundary from reading the environment directly. `src/**`
    // with the adapters directory excluded, because `src/!(adapters)/**/*.ts` does not match a file
    // sitting directly in src — exactly where the next layer would land.
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Only src/adapters reads the environment — take it as an argument.' },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // cursor.test.ts destructures the cursor on purpose: its state lives in closures,
      // so detaching the methods is the behaviour under test.
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['scripts/**', '*.config.ts', '*.config.cjs'],
    rules: { 'no-console': 'off' },
  },
);
