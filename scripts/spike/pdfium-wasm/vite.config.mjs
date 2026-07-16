import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Production-shaped build: relative base (loaded from file:// inside Electron),
// ES-module worker so `?worker` + the emscripten glue's `import.meta.url` wasm
// lookup behave exactly as they would in the real renderer bundle.
export default defineConfig({
  root: dir,
  base: './',
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(dir, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 0, // never inline the .wasm; force real asset resolution
  },
});
