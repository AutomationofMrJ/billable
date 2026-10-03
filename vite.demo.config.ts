// Builds the hosted browser demo into dist-demo/: the real store runs in the page on SQLite (WebAssembly).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const shim = (file: string) => fileURLToPath(new URL(`./demo/shims/${file}`, import.meta.url));
export default defineConfig({
  root: 'demo',
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { 'better-sqlite3': shim('better-sqlite3.ts'), 'node:crypto': shim('node.ts'), 'node:fs': shim('node.ts'), 'node:path': shim('node.ts') } },
  server: { host: '127.0.0.1' },
  build: { outDir: '../dist-demo', emptyOutDir: true, sourcemap: false },
});
