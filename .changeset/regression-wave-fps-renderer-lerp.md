---
"@q2/renderer-api": minor
"@q2/sw-renderer": patch
"@q2/host": patch
"web": patch
---

Regression wave: in-canvas fps, renderer hot-swap, smooth explosions, DM inhibit

- `apps/web`: the fps counter is rendered inside the game canvas HUD
  (top-left in-view via `drawPlayHud`, `fps N` in conchars font, gated by
  `cl_showfps`) and the DOM `#q2-fps` overlay is deleted (it sat over the
  controls panel) — `startPlayLoop` no longer mirrors fps to the DOM and
  `index.html` drops the `#q2-fps` node. `fpsHudAnchor` is now the top-left
  slot `{x: 8, y: 8}`; `fps.test.ts` + `display.test.ts` assert the canvas
  counter paints `FPS_GREEN` when enabled and nothing when gated.
- `apps/web`: `vid_renderer` no longer reboots the level (removed from
  `REBOOT_CVARS`) — it hot-swaps in place via the new `applyRendererCvar`
  (re-latches `boot.renderer` from the cvar; `resolveDisplay` already reads
  the cvar every frame), so player pos/health/ammo/monsters survive the
  switch. `index.ts` `onCvar` routes `vid_renderer` to the hot-swap instead
  of `startWithPak`. `reboot.test.ts` pins `cvarNeedsReboot` false + a
  host/driver-identity preservation test.
- `@q2/renderer-api` (frozen-contract additive evolution, BRAIN.md §6
  updated in the same PR): `Entity` gains optional `oldframe?: number`,
  `backlerp?: number`, `alpha?: number` (all backward-compatible; unset
  means unlerped + opaque). New `contract.test.ts` pins legacy literals
  and the new fields.
- `@q2/sw-renderer`: the alias backend interpolates verts oldframe→frame
  by `backlerp` (`clampBacklerp` helper, `frame.ts` wraps + clamps and
  defaults unset to `frameA == frameB, lerp 0` — golden-identical) and
  applies deterministic 4×4 Bayer screen-door translucency
  (`aliasAlphaKeeps`, threaded through `fillAffineTri`; `alpha <= 0`
  skips the entity). `alias.test.ts` covers lerp-midpoint math, alpha
  0/1/0.5 behavior, and the Bayer half-keep count.
- `@q2/host`: `ExtraRenderable` gains the same three optional fields and
  `renderCurrentView` forwards them to `Entity` (omitted when unset);
  `host.test.ts` pins the forwarding.
- `apps/web`: host `extraEntities` explosion frames emit
  `oldframe`/`backlerp` (age/0.1 frac) + `alpha` fade, so booms smooth
  instead of popping. New `smoothing.test.ts` pins mid-life frame/blend/
  alpha, aged-out silence, and `drainExplosions` live-only behavior.
- `apps/web`: DM skill inhibit applied web-side — `checkPickups`,
  `livePickupCount`, and `extraEntities` item submits skip skill-inhibited
  (lump `spawnflags` from `extra` via `skillInhibits`, since the numeric
  field is C-stripped post-spawn) + freed edicts. DM-only (1792) items are
  not submitted or pickable in SP (tested).
- `apps/web`: sky-hit silent free, web side — the driver renders live
  explosions only (`extraEntities`/`drainExplosions` prune by frame life),
  so freed-sky bolts (no explosion record) emit no tracer remnant or
  explosion light; verified + tested (server `SURF_SKY` trace flag stays
  the server lane's job).
