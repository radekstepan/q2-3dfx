---
'@q2/game': patch
'@q2/server': patch
---

Fix walkable debris, crawlspace clip, water jump, drowning (movement/physics lane).

- (A) Blown-brush atomicity: `SV_DamageBarrel` no longer frees the edict at
  damage time — C `barrel_delay` keeps the brush live AND solid for the 0.2s
  fuse, then frees + opens atomically at fuse blow (same tick as
  `SV_RemoveBrushClip`, the C `BecomeExplosion1`/`G_FreeEdict` moment). The
  old ordering left a 2-tick invisible wall (mesh hidden, clip still
  stopping bodies). Headless pins: blown-*20 walks open with no jump on
  standing + crouched hulls at patrol/sprint/16ms quanta, walk back out,
  and a soldier chases through in pure pursuit.
- (B) Crouched eye height: `PM_CheckDuck` now sets the C `viewheight -2`
  (feet+22) instead of the +12 guess, which parked the camera inside/above
  low crawlspace ceilings (see-through geometry, items above rendering,
  void/orange where the eye left the tunnel). Stand-up also matches C
  (`!allsolid` headroom check). Headless pins: settled crouch in the
  shotgun-secret tunnel keeps the eye under the roof plane inside a bounded
  pocket (roof/floor/walls terminate), stays ducked on release; renderer
  untouched (read-only diagnosis: leaf is solid-marked either way, the
  plane is the distinguisher).
- (C) Water jump: the out-of-water vault probe was inverted (vaulted in
  open water, never against a wall). Now C-exact (`!(contents & SOLID)`
  bails), fed by a new solid-aware point-contents hook
  (`bspPointContentsFor`, dry-land traces bit-identical — dry consumers
  only test `MASK_WATER`). The `TIME_WATERJUMP` branch runs C's vault
  physics (gravity, cancel as soon as falling). Also fixed: `pm_time`
  expiry now clears `WATERJUMP`/`LAND`/`TELEPORT` like C — previously a hard
  landing latched `TIME_LAND` forever and jumping never worked again.
  Headless pins: single swim impulse per press, no chained auto-jump, no
  vault in open water, vault only against a wall.
- (D) Drowning: new `P_WorldEffects` port (`packages/game/src/water.ts`:
  air grace, 4,6,8…15 ramp at 1/s past 12s, gasp/watr/burn/drown/gurp
  hooks, lava 3/level + slime 1/level sizzle) ticked server-side in
  `SV_GameTick` through the existing damage/sound events; air seconds
  exposed as `ServerState.playerAirLeft` for the HUD lane (no HUD files
  touched).

Follow-ups for other lanes: the web driver still installs the legacy
solid-less contents hook (one-line switch to `bspPointContentsFor` when
that lane touches `play.ts`), so the vault stays inert in the browser
until then; breather/rebreather + envirosuit frames have no items in this
sim (air runs on schedule).
