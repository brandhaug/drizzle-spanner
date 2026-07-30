import tseslint from 'typescript-eslint';

// The spec's package-layout section permits runtime imports only from these
// drizzle-orm base subpaths. Other dialects' cores are reference reading only.
const permittedDrizzleSubpaths = [
  'entity',
  'table',
  'column',
  'column-builder',
  'sql',
  'sql/expressions',
  'session',
  'query-promise',
  'runnable-query',
  'query-builders/query-builder',
  'selection-proxy',
  'subquery',
  'alias',
  'relations',
  'casing',
  'utils',
  'errors',
  'logger',
  'tracing',
  'migrator',
  'cache/core',
];

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: [
      'src/**/*.ts',
      'tests/**/*.ts',
      'packages/*/src/**/*.ts',
      'packages/*/tests/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'drizzle-orm',
              message:
                'Import from a permitted drizzle-orm base subpath (see the spec package-layout section), not the root.',
            },
          ],
          patterns: [
            {
              group: [
                'drizzle-orm/**',
                ...permittedDrizzleSubpaths.map((subpath) => `!drizzle-orm/${subpath}`),
              ],
              message:
                'Only the base subpaths listed in the spec package-layout section are permitted at runtime.',
            },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
