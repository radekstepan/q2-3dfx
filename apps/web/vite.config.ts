// q2ts-web dev-server config (M8.1): COOP/COEP headers ONLY — these unlock
// SharedArrayBuffer for the SAB-banded spanfill path. No preview/start/
// build changes (the production preview path was removed as flaky; the only
// runtime is `yarn dev`).
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        'map-viewer': resolve(root, 'map-viewer.html'),
      },
    },
  },
});
