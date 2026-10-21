import obsidianmd from 'eslint-plugin-obsidianmd';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ['eslint.config.*'] }, tsconfigRootDir: import.meta.dirname } }
  },
  { ignores: ['main.js', 'node_modules/**', 'test/**', 'esbuild.config.mjs', 'vitest.config.mjs'] }
]);
