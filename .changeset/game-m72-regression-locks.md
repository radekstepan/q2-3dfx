---
"@q2/game": patch
---

test(game): lock in explosion/anim/corpse/blaster regressions, fix green soldier bolt (M7.2)

Pure-data regression locks for the batch #3/#4 gameplay fixes (no contract
changes — additive exports only):

- Explosions: barrel fuse 0.2s + target_explosion delay scheduling, visual
  frames r_explode 15f / grounded 19f-base30 / ex_misc 4f, orange 350 /
  yellow 150 dlights with ex_poly/ex_misc alpha decay, 256-count ballistic
  yellow (0xe0) sparks, 14 bouncing barrel debris chunks (2+4+8) plus the
  func_explosive mass formula, T_RadiusDamage math (bbox-center distance,
  dmg-0.5*len, attacker half, radius dmg+40, LOS left to the caller), no
  scorch.
- Soldier/gunner anims: authentic attack fire frames (attack1 0-11 @2,
  attack2 12-29 @4, gunner chain 7/8/7), monsterFrameNumber first+frame
  clamp, death move holds the last frame, attack latch mid-move,
  FacingIdeal ±45° gate, per-tick M_ChangeYaw clamp (speed 20),
  entityAngles returns the stored yaw, corpses persist with death held.
- Shooting dead: corpses hittable (corpseHittable) until overkill gibs —
  soldier 3x sm_meat + chest + head2 over misc/udeath.wav + DEAD_DEAD,
  gib-first ordering, gibbed bodies unhittable.
- Blaster: G_ProjectSource spawn from feet (+fwd*24+right*8, z+=viewheight-8),
  muzzle dlight feet+fwd*18+right*16 radius 200+(rand&31) pure yellow,
  in-flight 200-yellow dlight, 0xe0 trail, SP damage 10, no beam for
  blaster/shotgun/machinegun.
- Green bolt fix: soldier weapon is skin-determined (m_soldier.c —
  skin<=1 blaster, <=3 shotgun, else machinegun), so basic (shotgun-skin)
  soldiers can no longer roll the blaster attack and emit projectile bolt
  entities; attackFiresBolt pins only soldier/blaster spawns a bolt, and
  the yellow (0xe0-0xe7 + white core 215) vs green (208-214, pak-verified)
  palette ranges are pinned with the old PELLET 208 green asserted banned.
