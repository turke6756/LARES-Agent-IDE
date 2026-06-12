import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Renderer unit tests. Deliberately NOT reusing vite.config.ts: that config
// sets root to src/renderer and pulls in the tailwind plugin, neither of which
// the test runner needs — and splice tests must stay CSS-free (plan §7 Phase 0).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    include: ['src/renderer/**/*.test.{ts,tsx}'],
    // Default env is node (splice tests are pure). Component tests opt into
    // jsdom per-file via `// @vitest-environment jsdom`.
    environment: 'node',
  },
});
