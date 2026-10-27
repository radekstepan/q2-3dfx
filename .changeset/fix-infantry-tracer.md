---
"@q2/server": patch
"@q2/game": patch
"web": patch
---

fix(game,server,web): infantry minigun tracers leave the gun muzzle

Infantry burst fire aimed from the wrong muzzle and the death spray aimed
at the player. C ground truth (`game/m_infantry.c`):

- `InfantryMachineGun` on the attack1 fire frame (attak111) always uses
  flash `MZ2_INFANTRY_MACHINEGUN_1` and aims at the enemy. The resolver
  keyed the flash off `ev.frame % 13`, so the frozen hold frame (index 10)
  read as flash 36 (`MZ2_INFANTRY_MACHINEGUN_11`) — the live muzzle parked
  ~16u forward / ~8u sideways / ~12u up off the gun, and every burst tick
  drew its streak from there. Attack1 now pins flash 26.
- The death2 spray (death211-222) walks flashes 27-38 and fires blind along
  `angles - aimangles[]` — never at the eye. The resolver aimed all 12
  corpse rounds at the player hull. The C `aimangles[]` table is now ported
  (`INFANTRY_DEATH_AIMANGLES` + `infantryDeathSprayAngles` in `@q2/game`),
  the spray walks flashes 2-13 with per-round muzzles, and each tracer flies
  its spray direction.
- The web driver never counted the chaingun as a monster shot
  (`infantry/infatck1.wav` missing from the `monshot` gate), so burst fire
  was invisible to the shot counters. Added.

Pins: server per-tick burst test (one tracer per 10Hz tick, each origin ==
live `projectSource` muzzle, length 48, never eye-ending), death-spray
flash walk 27-38 + spray-vs-eye divergence, game `aimangles[]` verbatim
table test, and a web driver-level burst test through the real tick loop
(muzzle origin per tick, monshot + chaingun sound). Base1-gate green.
