---
'web': patch
---

Menu/HUD lane: every boolean cvar in the config panel is now a checkbox with an on-hover description, and the position readout drops yaw for a dim grey.

- All 15 boolean cvars render as checkboxes (`CHECKBOX_CVARS` extended beyond `cl_showpos`: `cl_showfps`, `vd_16bit`, `vd_dither`, `vd_postfilter`, `vd_bilinear`, `vd_mipdither`, `vd_fog`, `vd_palettetex`, `vd_overbright`, `r_drawworld`, `cl_predict`, `cl_interp`, plus the lazily-registered `sw_wasm`/`sw_accum` span switches); the stale 0/1 `CVAR_OPTIONS` entries are removed so no boolean keeps a select. Checkbox wiring stays element-local `change` only — toggling any checkbox fires no game input and requests no pointer lock (pinned by a sweep test over every checkbox). Menu labels are left-aligned.
- Every menu row exposes its cvar doc as a `title` tooltip (`cvarDescription`, live registry doc with a verbatim `CVAR_DESCRIPTIONS` fallback so unregistered span switches still get tips; all strings copied from the cvar definitions in `@q2/config`, `play.ts`, `dom.ts`, `bands.ts`, `wasmSpans.ts`).
- `pos` readout is back to `pos X Y Z` (yaw removed from `formatPlayerPos`/`playerPosText`, 3 args) in dim neutral grey `POS_GREY 0xff999999` (one step above the `dim` crosshair tone so they never collide; replaces `POS_YELLOW 0xff66ffff`). Painted post-`r_brightness`-lift as before, so the display test's exact-colour survival pin at brightness 2.0 holds.
