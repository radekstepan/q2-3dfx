---
"@q2/game": minor
"@q2/server": minor
---

feat(game): pmove/collision, entities/items/doors/triggers, weapons, monsters (M5.1/M5.2/M5.3)

M5.1 pmove: port of qcommon/pmove.c — PM_StepSlideMove (slide + STEPSIZE=18 step-up, MIN_STEP_NORMAL 0.7), PM_ClipVelocity, PM_Friction/PM_Accelerate/PM_AirAccelerate, water moves, ladder support, duck hull (maxs z 4 / viewheight 12), water levels 0-3, jump (270 vel). Deterministic: dt from cmd.msec only (clamped 1-200ms), no wall-clock/RNG; world queries injected via setPmoveWorld. 10k-usercmd seeded replay reproduces origins bit-for-bit, plus slide-along-wall and step-onto-curb cases.

M5.2 entities/server: BSP entities-lump parser (quoted key/value blocks, // comments), edicts, item pickup (health/ammo/weapon/armor with caps), func_door/plat/button movers, trigger_once/multiple, teleporter. In-process 10Hz server tick (SV_Tick advances level.time by 0.1, runs movers). Scripted base1-logic test: button use drives door to end pos; trigger fires once.

M5.3 weapons/monsters: blaster (15 dmg, infinite)/shotgun (4x12 pellets, 1000/500 spread)/machinegun (8 dmg, 300/500 spread) with deterministic seeded spread and quad scaling; soldier (hp 30) + gunner (hp 175) data-table state machines (stand/walk/run/attack/pain/die), range()-based melee/ranged selection, BFS node-graph pathfinding stub.
