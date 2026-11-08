import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot('./src/web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fromRoot('./src/shared'),
    },
  },
  build: {
    outDir: fromRoot('./dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fromRoot('./src/web/index.html'),
        host: fromRoot('./src/web/host/index.html'),
        effect: fromRoot('./src/web/guest/effect.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'effect' ? 'effect.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // Allows quick phone checks against the dev server; production is served by Fastify.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
  preview: {
    port: 4173,
  },
  base: '/',
});
