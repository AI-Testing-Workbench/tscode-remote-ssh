import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  oxc: {
    target: 'es2022',
  },
  resolve: {
    alias: {
      vscode: resolve(__dirname, './test/mocks/vscode.ts')
    }
  },
  test: {
    environment: 'node',
    clearMocks: true,
    include: ['./test/**/*.test.ts'],
    reporters: 'dot',
    typecheck: {
      enabled: true,
      include: ['./test/**/*.test.ts'],
      tsconfig: './test/tsconfig.json',
    },
    coverage: {
      reporter: ['html'],
      reportsDirectory: './coverage',
    },
  },
});
