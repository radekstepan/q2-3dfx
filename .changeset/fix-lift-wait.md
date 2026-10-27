---
'@q2/server': patch
'web': patch
---

Fix exit lift auto-cycling: the doors at (-1669,1514,120) now wait for the player instead of opening/closing forever (movers lane).

- Lump evidence (real base1 entities): the "elevator" is the exit complex —
  the *31 plug (func_door, angle -2, drops 156), the *32/*33 team sliders
  (slide ±64 @ 50 u/s, NOMONSTER), and the *12 func_train (t91 → t88 →
  t89 wait .5 → t90, speed 40). base1 ships ZERO func_plat, so the C plat
  rules in suspect (a) are moot here; no door carries TOGGLE and *32's
  target t75 dangles, so suspect (b) has no live cascade (as 0e7f862
  proved for t91).
- Root cause (suspect (c), both halves): `SV_TouchDoorsAt` built each
  slider's trigger volume from the door's LIVE origin (ox/oy/oz offset),
  while C `Think_SpawnDoorTrigger` bakes ONE static trigger from the rest
  bounds. Once *33 slid +64y away, the camper at y=1514 fell outside the
  shifted volume, the TOP wait expired, the slab closed, re-touched, and
  cycled open/close 7× in 400 driver ticks. The touch also re-ran
  `moverUse` from WAITING every tick (zero-leg restart → per-tick target
  re-fire, e.g. *19→t69, and per-tick door-sound edges), where C
  `door_go_up` on TOP only resets the wait.
- Fix (C ports, no contract change): volumes are baked from the rest
  bounds (the rot branch already was); slider touch runs the new
  `doorTouchUse` (packages/server/src/doors.ts) — C door_use/door_go_up:
  UP is a no-op, TOP/WAITING resets the full wait (no restart, no target
  fire), BOTTOM — or DOWN mid-close — starts the UP leg and fires the
  door target once; TOGGLE reverses at TOP. The rot branch now also
  reaches TOP bodies (rotUse already encodes the C reset). Server
  monster touches share the same function, so both sims agree.
- Done = play-verified IN THE DRIVER LOOP: new gate case (t) camps the
  reported spot 400 ticks (doors open once, then rendered offsets frozen;
  *12 never starts, origin/sim/mesh all (0,0,0)), then boards the lift
  footprint + presses the *13 button chain (the button's own use entry —
  the driver has no button-touch path) and the train runs t88→t89→t90
  once, arriving at rendered/sim (-16,0,40) and parking 150 ticks with
  nobody aboard (no second cycle). Gate file 20/19+1 green; the new
  unit pins (doors.test.ts doorTouchUse trio, server.test.ts edge-camper
  parks + target-fires-once) fail red on the pre-fix code.
