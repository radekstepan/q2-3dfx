---
'@q2/server': minor
---

M5.2 base1 world fidelity: barrels/runner/ships/doors/gunner/skill.

- Skill cvar honored (g_spawn.c/g_combat.c): `SV_SetSkill` (floor+clamp 0-3,
  default 1), `inhibitedBySkill` roster gating at spawn (SPAWNFLAG_NOT_*) and
  `skillMultiplier` easy-half damage scale. base1 SP roster is now 606 edicts
  / 35 items / 17 monsters at skill 1 (19 at skill 2+). The exit machinegun
  and the crouch-hole jacket are 1792 DM-only items: correctly absent in SP.
- Spawn grounding (M_droptofloor): optional drop-trace hook snaps barrels and
  non-triggered monsters to the floor (base1 barrels move exactly 1/32, the
  start-room soldier drops from its floating lump z to the floor).
- Server monsters: `SV_MonsterTick` runs chase/locomotion/think per 10Hz tick
  with ambush acquire, LOS gating and muzzle-gated fire events carrying the
  skill damage scale. The start-room soldier holds until seen, then closes
  and fires (pinned by test).
- Trains/ships (g_func.c): func_train + misc_strogg_ship ride path_corner
  chains with teleport corners, waits and pathtargets; trigger_always starts
  the three curtain ships at spawn; the exit train waits for button *13.
  `SV_TouchDoorsAt` implements Touch_DoorTrigger (+60 x/y) and fires door
  targets on opening (door_go_up).
