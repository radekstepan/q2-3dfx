---
"@q2/server": patch
---

fix(server): ship teleport-loop wrap, spawn drop floor (M5.2)

- Ship loops stall (BUG 1): all three base1 `misc_strogg_ship` loops close
  through a TELEPORT `path_corner` (t147->t143, t141->t137, t130->t131).
  C `train_next` chains via `self->target = ent->target` (`G_PickTarget`),
  so the teleport snaps and travel resumes at the loop head forever; the
  linear `seg++` array instead ran off the end at the teleport and the ships
  froze after ~one circuit (`arrived=true`). `TrainCorner` now carries its
  `name`/`target` links and a new `advanceTrainSeg` follows the arrived
  corner's target link (wrapping cyclic chains, ending dangling ones like
  C's "bad target" return); teleport snaps chain through `trainNext` with
  the C connected-teleport guard. The exit `func_train` (t88->t89->t90, no
  target) still terminates. New test flies all three ships 700 ticks and
  pins multi-loop travel (cumulative >3000 units each, never arrived —
  fails on the pre-fix build).
- Spawn drop below grade (BUG 2): the start-room `monster_soldier_light`
  lump (348,-348,-64) floats above a clip-sealed deck. C `M_droptofloor`
  traces `MASK_MONSTERSOLID` and rests it at -84; a mask-1 world trace
  misses the deck and overshoots to -86.27 (below grade — the reported
  value, reproduced exactly). New server-owned `SV_DropTraceFor`
  (`MASK_MONSTERSOLID_C`, C-exact for both monsters and exploboxes);
  `SV_SpawnEntities` docs point `dropTrace` at it, the base1 spawn helper
  uses it, and a new test pins monster0 z at -84 while pinning the mask-1
  overshoot as the failure mode. Web lane note: `apps/web` `placeMonsters`
  still grounds through its own mask-1 `bspTraceFor` default — adopting
  `SV_DropTraceFor` there is a web-lane change (out of this lock).
