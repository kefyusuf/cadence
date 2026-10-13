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
      name: 'scheduler-is-pure',
      severity: 'error',
      comment: 'src/scheduler receives its timer and its clock as arguments. Reaching for a builtin timer here would make a wait impossible to test without real time passing.',
      from: { path: '^src/scheduler' },
      to: { dependencyTypes: ['npm', 'core'] },
    },
    {
      name: 'core-and-domain-do-not-know-scheduler',
      severity: 'error',
      comment: 'The scheduler drives the engine from the outside. core and domain must stay loadable without it, otherwise the reusable part of the package inherits its async machinery.',
      from: { path: '^src/(core|domain)' },
      to: { path: '^src/scheduler' },
    },
    {
      name: 'core-domain-scheduler-do-not-know-adapters',
      severity: 'error',
      comment: 'Hexagonal direction: adapters depend on the core, never the reverse. An import from src/adapters into core, domain or scheduler would give the reusable engine a dependency on the outside world.',
      from: { path: '^src/(core|domain|scheduler)' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'config-is-pure',
      severity: 'error',
      comment: 'src/config validates values it is handed. Importing dotenv or reading a file here would move the boundary between "the environment" and "the rules" back into the part that is supposed to be testable without either.',
      from: { path: '^src/config' },
      to: { dependencyTypes: ['npm', 'core'] },
    },
    {
      name: 'core-domain-scheduler-do-not-know-config',
      severity: 'error',
      comment: 'Configuration is how the application is assembled, not part of the engine. If core, domain or scheduler imported src/config, the published recurrence engine would need an environment to run.',
      from: { path: '^src/(core|domain|scheduler)' },
      to: { path: '^src/config' },
    },
    {
      name: 'config-do-not-know-adapters',
      severity: 'error',
      comment: 'config-is-pure cannot see this: an import of src/adapters/env-config.ts from src/config would reach process.env transitively while every gate stays green, which is the one thing the configuration layer exists to prevent.',
      from: { path: '^src/config' },
      to: { path: '^src/adapters' },
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
