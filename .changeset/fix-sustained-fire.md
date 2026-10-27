---
'@q2/game': patch
'@q2/server': patch
---

C-true sustained fire: ss attack4 burst + infantry cock/hold cadence

Ground truth: `m_soldier.c` soldier_attack/soldier_fire4
(AI_HOLD_FRAME hold, 6-frame attack4, flash machinegun_flash[3],
monster_fire_bullet dmg 2), `m_infantry.c` infantry_cock_gun/infantry_fire
(infatck3 cock, 10-25 frame pausetime, 3dmg bullets), `g_monster.c`
M_MoveFrame (freeze + thinkfunc re-run + expiry bullet), `cl_fx.c`
muzzleflash sounds (solatck3/infatck1 per shot).

- ss soldier (skin 4+) now plays the C attack4 strafe (6 frames, fire at
  index 2 = attak403, flash MZ2_SOLDIER_MACHINEGUN_4) picked by a
  skin-aware selectAttack, instead of the attack1/attack2 roll.
- The fabricated same-tick 3-round fan is gone: each event resolves ONE
  2dmg bullet (solatck3.wav) through the live resolver; the burst is the
  AI_HOLD_FRAME hold across 10Hz ticks (pausetime (3+rand%8)*FRAMETIME,
  arming + frozen + expiry ticks all fire: k+1 = 4-11 rounds).
- Infantry cock is real: the cock frame emits infatck3 and arms the
  1.0-2.5s pausetime; the fire frame freezes and re-fires one 3dmg bullet
  per tick (n-6 = 4-19 rounds), gated by the same canSee rule as live
  fire. New AI_HOLD_FRAME flag (burstHeld) mirrors C exactly, including
  the expiry bullet and the move-switch flag clear.
