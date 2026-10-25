---
'@q2/game': minor
'@q2/server': minor
---

Real-pak model/skin assets + blaster bolt/muzzle specs (game + server only, no renderer contract change).

- Asset tables (`@q2/game/assets.ts`): `modelForMonster`/`skinForMonster`/`skinsForMonster` (soldier + gunner `tris.md2`/`skin.pcx`/`pain.pcx` per m_soldier.c/m_gunner.c), `modelForWeapon`/`viewModelForWeapon`/`worldModelForWeapon` (v_blast/v_shotg/v_machn + g_weap per g_items.c), `skinForWeaponModel` (incl. the g_blast `base.pcx` exception), `modelForBolt`/`skinForBolt` (`models/objects/laser/*` per fire_blaster), `monsterFrameFor` (move first-frames for Entity.frame), `monsterKindForClassname`, and `resolvePakAsset` (devroom-safe fallback when the pak lacks an entry). All names verified against real pak0.pak via Q2_PAK listing.
- Blaster bolt + muzzle dlight: `fireWeapon` now returns exactly one `bolt` spec (model/skin/speed 1000/life 2s/EF_BLASTER/damage) per fired blaster shot plus exactly one `muzzle` dlight request (intensity 200, yellow [1,1,0] per cl_fx.c/cl_ents.c) per fired shot of any weapon; both null when not fired. Hitscan weapons keep pellets only. The driver renders the bolt as an md2 entity and pumps the dlight on its existing paths.
- Lite M5.3 state machines untouched; no full AI. Vitest: game 53 passed (12 new asset/bolt tests); server 13 passed incl. the WIRE base1 bot traversal, plus a Q2_PAK-gated suite pinning every helper path present in pak0.pak.
