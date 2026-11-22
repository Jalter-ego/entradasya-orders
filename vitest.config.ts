import { defineConfig } from 'vitest/config';

// Unit tests: sin Postgres ni red. Las dependencias se reemplazan con mocks.
// La suite de integración (con base real) está en vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup/env.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/types/**', '**/*.d.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
