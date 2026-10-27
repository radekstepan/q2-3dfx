---
"@q2/game": patch
"@q2/server": patch
---

fix(game,server): monsters round corners — trail advance + movestep slide

Blind pursuit stalled at the last sighting: after reaching it, PickFirst
steered straight at a trail marker through the corner wall and the body
pressed into the face forever (no trail-next advancement, no wall slide).
Three C-parity fixes, all in the owned monster lane:

- ai_run sidestep probe (g_ai.c `new` block): when a fresh pursuit leg is
  adopted and the hull leg is blocked, probe ±16u lateral sidesteps and
  steer at a materially clearer side (TEMP goal, original stashed and
  restored on arrival). Dust-winner sidesteps are rejected so the body
  cannot dither in place.
- M_MoveToGoal/SV_NewChaseDir-lite heading sweep in locomotion (opt-in):
  a blocked direct step sweeps goal-relative alternate headings and takes
  the first fully clear one, with server-committed chirality so
  wall-following keeps its hand instead of oscillating.
- Duck-aware movestep hull: the stair/step wrapper now traces the C duck
  hull (maxs z 0) while the duck move plays instead of the standing hull.

Play-verified: new server gate `monster-corner.test.ts` — a monster whose
player breaks LOS around a synthetic L-wall reaches the last sighting
blind, rounds the wall plane (x > 116), and closes 291u → engagement range
instead of stalling at the slab face. Existing gates (i)/(j)/(k) and the
server base1 suite stay green (one stale pin evolved: the corridor runner
now closes to point-blank <80 before its first volley, so the first event
labels 'melee' — still the skin gun firing, soldier melee is NULL in C).
