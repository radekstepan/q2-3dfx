---
"@q2/bsp": patch
"@q2/client": patch
"@q2/config": patch
"@q2/filesystem": patch
"@q2/formats": patch
"@q2/game": patch
"@q2/host": patch
"@q2/input": patch
"@q2/math": patch
"@q2/renderer-api": patch
"@q2/server": patch
"@q2/sound": patch
"@q2/sw-renderer": patch
"@q2/testkit": patch
"@q2/voodoo": patch
---

Add `module` + `exports` (import → `dist/index.mjs`, require → `dist/index.js`) to all engine packages. Without an ESM entry Vite dev serves the CJS `dist/index.js` raw via `@fs`, which browsers parse as export-less ESM (`devroomWorld` import failure in `apps/web`). Verified `yarn start` now resolves `@q2/*` to real ESM; build/typecheck/test all green.
