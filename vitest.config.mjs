import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // The obsidian npm package ships only type definitions; tests run against a stub.
    alias: { obsidian: fileURLToPath(new URL('./test/obsidian.ts', import.meta.url)) }
  },
  test: { include: ['test/**/*.test.ts'] }
});
