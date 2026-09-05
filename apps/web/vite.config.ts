import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: {
    fs: {
      // scenarios/ and params/ live at the workspace root.
      allow: [resolve(__dirname, '../..')],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
