/**
 * Layering gates for cadence. Run with `npm run lint:deps`.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A cycle makes every module in it impossible to load or test in isolation.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-is-pure',
      severity: 'error',
      comment: 'src/core must not reach for Node builtins or packages: the recurrence engine has to run in a browser, too.',
      from: { path: '^src/core' },
      to: { dependencyTypes: ['npm', 'core'] },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'src/domain holds types and validation only; adapters that need I/O belong in src/adapters.',
      from: { path: '^src/domain' },
      to: { dependencyTypes: ['npm', 'core'] },
    },
    {
      name: 'core-does-not-know-domain',
      severity: 'error',
      comment: 'The recurrence engine is reusable on its own; the board vocabulary is layered on top of it, never the reverse.',
      from: { path: '^src/core' },
      to: { path: '^src/domain' },
    },
    {
      name: 'src-does-not-know-dev-only-paths',
      severity: 'error',
      comment: 'Shipping code may not import tests, verification scripts or build output.',
      from: { path: '^src' },
      to: { path: '^(test|scripts|dist)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['(dist|coverage|node_modules)'] },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
