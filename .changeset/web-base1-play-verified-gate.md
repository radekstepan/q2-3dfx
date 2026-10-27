---
'web': patch
---

test(web): permanent base1 play-verified gate (Phase 4)

- Consolidates the Phase 0 driver-level bot into `base1-gate.test.ts`: seven
  Q2_PAK pins asserting rendered/submitted state through the real
  driver+server loop — both spawn barrels explode (28 debris extras, live
  dlights), monster #341 closes ~350u to <=100u on a live strafing player
  (snapshot + renderView), door *31 renders open (>=100u verts) then
  re-closes (<0.5u), the stair-secret drop holds the deck (z 115-125), TTK
  <= 4 at skill 1, skill reboot re-filters 3/5/3 infantry (17/19/17
  submitted), doors + glass grafted and closed at spawn (232 faces).
- fix(web): `syncDoors` no longer skips the exact-rest tick, which left baked
  verts holding up to one speed-step of offset (the plug read 6u open while
  the sim was closed). The gate's door pin caught it.
