import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// TEST_DATABASE_URL vive en .env.test (fuera de Git). Nunca se lee el .env de desarrollo.
if (existsSync('.env.test')) process.loadEnvFile('.env.test');

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/setup/globalSetup.ts'],
    setupFiles: ['tests/integration/setup/env.ts'],
    // Los archivos comparten la base de pruebas: se ejecutan uno por vez.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
