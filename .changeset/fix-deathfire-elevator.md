---
"@q2/server": patch
"@q2/game": patch
"web": patch
---

fix(game,server,web): soldier death-fire trace; elevator door no longer starts train

Combat/movers lane (2 items):

A. A dying soldier's last-ditch blaster now renders. C ground truth
(`game/m_soldier.c`): `soldier_move_death1` (FRAME_death101-136) is the
only death move in the game with fire callbacks — `soldier_fire6`
(flash 5) at 0-based frame index 21 and `soldier_fire7` (flash 6) at
index 24, skin-gunned by `soldier_fire`, aimed straight along the facing.
Gunner (`m_gunner.c` death, all NULL) and infantry (`m_infantry.c`
death1-3, all NULL) deaths never fire. Port: the lite soldier death1
table tags indices 21/24 `'fire'` (`packages/game/src/monsters.ts`,
C-cited comment); `deathFireEvent` (`packages/server/src/monster-ai.ts`)
emits a skin-gunned event from the tick's dead branch through the live
`resolveMonsterFire` path (bolt + muzzle + tracer + damage + sound —
blaster skins spawn real foe bolts; shotgun/machinegun resolve hitscan
exactly like live fire); unconditional like C (no LOS gate — the
ballistic bolt detonates on cover instead of phasing). Corpses stay
hittable and gibbable per the existing overkill ordering (re-hits hold
the corpse, past gib-health minces, gibbed bodies go silent). The one
documented deviation: C rolls death1-6 at random with only death1 armed
while the lite soldier always plays death1, so every lite death plays
the armed move — the trace agrees with the rendered animation.

B. The exit lift (`func_train` t88-t90, targetname t91) no longer has any
door-driven start path — verified, not just asserted. C ground truth
(`game/g_func.c`): doors fire targets when they START opening
(`door_go_up` → `G_UseTargets`, never at top arrival — `door_hit_top`
only schedules the return), and named trains wait for a use
(`func_train_find` auto-starts only targetname-less trains). Base1 lump
evidence: the exit plug *31 (targetname t4) carries NO target, so no
door cascade can reach t91; only button *13 (target t91) and the
skill-inhibited (1792 = NOT_EASY/MEDIUM/HARD) `trigger_always` target
t91. The sim already matched C on all three points, so the fix is a
regression pin, not a cascade rewrite (doors still fire targets on open
— the t37 exit chain depends on it): opening *31 by use or by
Touch_DoorTrigger leaves the train parked; firing t91 still runs the
full t88→t89→t90 ride. A real-data audit fires every distinct lump
targetname and proves only t91 starts the lift.

Play-verified: server `monster-ai.test.ts` gains the death1 emission pin
(frames exactly [21, 24], skin-keyed blaster event, helper gates,
corpse re-hit holds then gibs, gibbed silence) plus the live-resolution
pin (foe bolt in flight, 2 foe muzzles, 2×5 player damage); server
`base1.test.ts` gains the exit-door-vs-lift pin and the 120-targetname
no-fan-out audit (existing 700-tick ship loops + t91 ride test stay
green); base1-gate grows to 17 tests — new (q) pins the rendered
last-ditch shot (foe-bolt MD2 in flight out of the corpse's muzzle on
the corpse→player bearing + muzzle-flash drain, both inside the
death-frame 21/24 window).
