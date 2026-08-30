import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/setup-crypto.ts'],
    include: ['**/*Test.ts', '**/*test*.ts', '**/*.spec.ts'],
    exclude: process.env.INCLUDE_INTEGRATION_TESTS
      ? ['**/Abstract*.ts', 'vitest.config.ts', 'node_modules/**']
      : ['**/testintegration/**', '**/Abstract*.ts', 'vitest.config.ts', 'node_modules/**'],
    ...(process.env.INCLUDE_INTEGRATION_TESTS
      ? {
          testTimeout: 180000,
          hookTimeout: 180000,
          // All test files share one chain and the same genesis wallet
          // (ML-DSA seed 0x01). Java's remote.sh runs each test class in its
          // own mvn invocation, so run files serially to match: parallel files
          // contend for the same UTXOs and cause confirmation timeouts.
          fileParallelism: false,
        }
      : {}),
  },

});
