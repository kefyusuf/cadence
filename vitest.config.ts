import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // model.ts and ports.ts are interfaces and type aliases only: they emit no runtime code.
      exclude: [...coverageConfigDefaults.exclude, 'src/domain/model.ts', 'src/domain/ports.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
