---
'@q2/config': patch
---

Fix ESM/CJS configuration-store split: keep the cvar registry (and feature flags) on a per-runtime `globalThis` singleton so supported ESM (`import`) and CJS (`require`) consumers in the same process observe one shared configuration state. Renderer selection (`vid_renderer`), worker cvars, and the vd_* scanout profile can no longer silently disagree between the bench/host path and the renderer path. The store is seeded with defaults exactly once (a late-loading second module copy never wipes live state); `resetCVars` still restores defaults, and separate runtimes (workers, processes, test isolates) stay isolated via their own `globalThis`.
