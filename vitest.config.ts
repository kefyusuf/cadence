import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // ports.ts is interfaces only: it emits no runtime code. model.ts now does — the status list — and
      // the line is hit as soon as the server modules load, so it is measured. main.ts is the process
      // entry point: it reads the environment through an adapter and opens a socket, and `node
      // dist/server/main.js` plus the image selfcheck are what prove it, not a vitest run.
      exclude: [...coverageConfigDefaults.exclude, 'src/domain/ports.ts', 'src/server/main.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
