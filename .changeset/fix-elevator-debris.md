---
'@q2/server': patch
'web': patch
---

Fix elevator parked on door-open; debris at -384,33 unsticky (movers/clip lane).

- (A) Exit lift: reproduced in the DRIVER LOOP (real tick + DoorSync +
  render), not a server unit BFS — touch-open of the *31 plug, the real
  walk-in through the *32/*33 doors, plug ride/board attempts, button
  approach, and a 200-tick combat soak at the exit. The server sim AND the
  train graft both stay parked in every scenario: no t91 fires, the *12
  origin stays (0,0,0), and the brush mesh offset stays 0 (mesh tracks sim
  bit-exactly, including during a legit t91 ride: mesh == sim every tick).
  Neither suspect held — no graft coupling (wrong edict / rest-vs-live
  mixup), no sim cascade in the full loop. The only exit motion is the
  C-correct *31 plug descent (pos2 -156). Gate (r) pins all of it.
- (B) Debris spot (-384.4,33.8,-16): the solid is the LIVE func_wall *9
  slab (feet exactly -40 = slab top -40, coplanar with the world floor —
  not a leftover clip, not debris, not world rock). The clip sweep
  `sweepBrushBox` lacked the C `DIST_EPSILON` (1/32) enter/leave bias that
  `traceBox` has, so clip landings rested EXACTLY on contact while world
  landings rest +1/32 — a C-unreachable glued state where every overlapping
  sweep read allsolid (0.0 in N/S/W, E-only escape). The fix ports the
  cmodel.c `CM_ClipBoxToBrush` bias into the slab sweep (entry -eps/|d|,
  exit +eps/|d|, `enterfrac` init -1 so contact still grounds; startsolid
  stays on the unbiased entry, allsolid-on-exact-touch unchanged per the
  C d1 == 0 rule). Settling now lands +1/32 grounded (ge=92) and N/S/E
  walk free standing, N crouched, W walks 43u to the world rock face at
  x=-412 and holds there (world-only C-mask trace blocks with fraction <
  1 — solid rock, C-authentic, stays), and soldier #341 chases through the
  spot to the player. Gate (s) pins all of it; verified red pre-fix (N-leg
  0.0) and green post-fix.
