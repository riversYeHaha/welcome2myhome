import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist/server',
  clean: true,
  sourcemap: true,
  splitting: false,
});
