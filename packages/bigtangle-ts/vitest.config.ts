import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*Test.ts', '**/*test*.ts', '**/*.spec.ts'],
    exclude: process.env.INCLUDE_INTEGRATION_TESTS
      ? ['**/Abstract*.ts', 'vitest.config.ts', 'node_modules/**']
      : ['**/testintegration/**', '**/Abstract*.ts', 'vitest.config.ts', 'node_modules/**'],
  },

});
