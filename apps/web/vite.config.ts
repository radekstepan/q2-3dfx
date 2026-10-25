// q2ts-web dev-server config (M8.1): COOP/COEP headers ONLY — these unlock
// SharedArrayBuffer for the SAB-banded spanfill path. No preview/start/
// build changes (the production preview path was removed as flaky; the only
// runtime is `yarn dev`).
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
