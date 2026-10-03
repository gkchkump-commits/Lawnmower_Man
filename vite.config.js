import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));

// Renderer lives in src/, static assets (avatar packs, models) in public/ → served at /assets/...
// base './' so the built app also works when Electron serves it from app://lawnmower/.
export default defineConfig({
  root: resolve(here, 'src'),
  publicDir: resolve(here, 'public'),
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(here, 'src/index.html'),
        avatar: resolve(here, 'src/dev/avatar.html'),
      },
    },
  },
  test: {
    root: here,
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    testTimeout: 20000,
  },
});
