---
"@q2/game": minor
"@q2/server": patch
---

RELEASE-13: dying-enemy collision timing, soldier death variety, patrol beats with C sight gating. Dying bodies keep blocking until the death-move endfunc latches `deadDone` (SVF_DEADMONSTER timing); soldier deaths 1/2/4/5/6 + head-shot death3 per `soldier_die` with real frame tables (only death1 armed); base1 patrol beats walk `path_corner` chains while unseen with `FindTarget` range/infront/hostile gating, damage + gunfire-noise wake, deterministic timer stream.
