---
"@q2/host": patch
"@q2/client": patch
---

fix(host,client): eye-anchored viewmodel, authentic weapon anims, no stop jitter

Host renders the first-person gun AT the eye (id SV_CalcGunOffset zeroes
gunoffset; composition is baked into the v_weap verts) instead of
+fwd*22/right*8/up*5, which shrank the blaster to a floating toy and
double-applied the baked composition. Driver uses the real Weapon_Generic
frames (blaster fire 5/idle 9, shotgun 8/19, machinegun 4/6). Blaster is
a 1000 u/s projectile with EF_BLASTER trail and TE_BLASTER impact
(40-spark burst + flash + lashit), hitscan weapons draw no beam (only the
railgun does), barrels/target_explosion/func_explosive explode with
T_RadiusDamage, and trigger_always fires at spawn. Stop jitter is fixed
two ways: the host builds the current cmd BEFORE the 10Hz ticks (no stale
100ms move after release) and CL_PredictPmove coalesces identical staged
cmds into one friction step matching the server's chunking.
