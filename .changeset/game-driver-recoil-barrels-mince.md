---
'@q2/game': minor
'@q2/host': patch
'@q2/client': patch
'@q2/sw-renderer': patch
---

Viewmodel recoil/sway data, barrel/explosion/gib data, enemy tracer/mince support.

- `m_flash.ts` (new): soldier/gunner slices of `monster_flash_offset[]` as an MZ2-id-keyed table (id *1.2/*1.15 scales, incl. the corrected BLASTER_8 row) plus pure `projectSource` (G_ProjectSource); exported via index.
- `monsters.ts`: soldier attack1/attack2 carry C-authentic `fire` tags (3rd/5th frame); gunner chain/fire/runandshoot/grenade tags kept. `MonsterState` gains `gibbed` (DEAD_DEAD); `monsterPain` returns `gib|dead|pain|none` with the gib-health check before the dead re-entry gate (g_combat.c order), gibbed unhittable, plain corpses still hittable.
- Web driver (apps/web, no renderer/host/client edits): Weapon_Generic-lite gunframe (fire→idle walk in step, viewModel reports it), `viewKick()`/`gunAnglesDelta()` with the exact host shapes (blaster/shotgun -2 kick for one tick; SV_CalcGunOffset-lite sway, zeros when still), 0.2s barrel fuses + target_explosion delays, explosion1/2/blaster kinds with baseframe/yaw + kind-based dlights, 256-count ballistic boom sparks, debris (2+4+8 / mass formula) + gibs (3 meat/chest/head) with toss-lite physics, fire-gated monster return fire (orange tracers, foe bolts, enemy muzzle dlights, solatck/gunatck sounds), corpse mince via painMonster.
