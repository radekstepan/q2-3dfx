---
'@q2/web': patch
---

Fix browser water detection + drowning damage on schedule (water lane).

The server sim could drown (`ae2e1e5`: `P_WorldEffects` in `SV_GameTick`)
but the browser never did: the web driver installed the legacy solid-less
`bspContentsFor` for pmove and never supplied `contents` to `SV_Tick`, so
the tick sampler fell back to the null `SV_WorldContents` and early-returned
(no `waterlevel`/`watertype`, no damage), and the out-of-water vault stayed
inert (its `CONTENTS_SOLID` probe is always false without the bit).
Driver pmove-world/contents wiring only — no sim logic, no HUD, no contract
changes (dry-land consumers test `MASK_WATER` only: dry traces bit-identical):

- `LocalDriver` now installs the solid-aware `bspPointContentsFor` (same
  hook the server vault/damage path reads) for `setPmoveWorld` and passes
  it as `contents` into every `SV_Tick`, so `stepWorldEffects` samples the
  real base1 leaves in-browser.
- State exposure only: `playerAirLeft` getter (server air supply, HUD-lane
  input) and a `heardSounds` log so tests can pin the enter/gasp/drown
  hooks without touching the mixer or HUD.
- Play-verified in the driver loop (`apps/web/src/drowning.test.ts`,
  Q2_PAK-gated, real base1 lump): (t1) a submerged head categorizes
  waterlevel 3, air drains from the 12s grace, health drops 4,6,8… at 1/s
  capped at 15 with `watr_in` + per-tick gurp hooks, and resurfacing
  recovers air to 12 with `watr_out` + gasp and no further damage; (t2) the
  vault engages against a real pool wall (`TIME_WATERJUMP` + 270 post-tick
  impulse). Negative control: both cases fail on the pre-fix wiring.
- Dry-land determinism untouched: no `packages/game`/`packages/server`
  changes, so the 10k pmove replay and `base1-gate` 17/17 stay green.
