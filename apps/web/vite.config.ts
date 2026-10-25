import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { mkdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Production bundle lands in dist-web/ so the tsup library build in dist/
// (used by workspace typecheck/tests) is left untouched.
// NOTE (M8.1): worker + SharedArrayBuffer banding will need COOP/COEP here:
//   server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Link the local pak0.pak into the preview root so `yarn start` boots
 * straight into base1 — without committing 184MB to git. Resolves like
 * tools/q2-paths.sh: $Q2_PAK wins, else ../external/q2/baseq2/pak0.pak.
 * No readable pak (CI / asset-less deploys) → no link, and the app's
 * bundled-pak fetch 404s back to the devroom boot. A symlink, never a copy.
 */
function linkLocalPak(outDir: string): void {
  const pak = resolve(process.env.Q2_PAK || join(here, '..', '..', '..', 'external', 'q2', 'baseq2', 'pak0.pak'));
  mkdirSync(outDir, { recursive: true });
  const link = join(outDir, 'pak0.pak');
  try {
    unlinkSync(link);
  } catch {
    /* link absent — nothing to clear */
  }
  let readable = false;
  try {
    readable = statSync(pak).isFile();
  } catch {
    readable = false;
  }
  if (!readable) {
    console.log(`[q2-web] no readable pak at ${pak} — preview boots devroom`);
    return;
  }
  symlinkSync(pak, link);
  console.log(`[q2-web] linked ${link} -> ${pak}`);
}

function q2PakLink(): Plugin {
  return {
    name: 'q2-pak-link',
    configurePreviewServer() {
      linkLocalPak(join(here, 'dist-web'));
    },
  };
}

export default defineConfig({
  server: { port: 5173 },
  preview: { port: 5173 },
  build: { outDir: 'dist-web' },
  plugins: [q2PakLink()],
});
