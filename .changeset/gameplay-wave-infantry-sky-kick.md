---
"@q2/game": patch
"@q2/server": patch
"@q2/bsp": patch
---

Gameplay wave: INFANTRY lite def, SP skill-inhibit pins, sky-hit silent free, machinegun kick + real melee/grenade sounds

- `@q2/game`: `INFANTRY` lite def (m_infantry.c frame dists + MD2 FRAME_*
  bounds: stand 50, walk 74, run 92, pain 100/110, duck 120, deaths
  125/145/170, mgun attack1 184 fire@idx10, melee attack2 199 smack@idx5;
  100hp / gib -40 / mass 200) with `MonsterKind` widened to
  `soldier|gunner|infantry`, `selectAttack`/`attackMoveFor` infantry
  branches, random death1/2/3 + pain1/2 in `monsterPain`, and
  `INFANTRY_HP`/`INFANTRY_GIB_HEALTH` exports. `machinegunKick(shots,
  rand)` ports the p_weapon.c per-shot crandom kick walk + burst clamp 9;
  `INFANTRY_{GUN,SWING,MELEE,COCK}_SOUND` + `GUNNER_GRENADE_SOUND` pin the
  C sound names (pak-verified) and `MONSTER_MELEE_SOUND_ALIAS` preserves
  the legacy placeholder string for the web lane. `TraceResult` gains
  optional `surfaceFlags` (additive, backward-compatible).
- `@q2/bsp` (additive only, no signature changes): `Trace` gains optional
  `surfaceFlags` from the lead brushside texinfo (cmodel.c leadside
  equivalent; first-side-wins on coplanar sides) + `SURF_SKY` export.
  Verified against real base1: upward traces report flags 5 (LIGHT|SKY).
- `@q2/server`: `monsterKindOf` maps `monster_infantry` (base1: 3 at
  skills 0/1, 5 at 2/3 — same think/chase/locomotion as soldier);
  `resolveMonsterFire` resolves the infantry mgun bullet (dmg 3,
  infatck1.wav) and the true smack (5+rand%5, melee2.wav) while
  soldier/gunner point-blank events resolve as gunfire (C melee is NULL);
  `monster/melee.wav` no longer emitted. `stepBoltFlight` frees sky-flagged
  bolts silently (trace first; no trail/explosion/sparks/sound).
  `SV_TraceFor`/`SV_ClipTrace` pass `surfaceFlags` through.
  `SV_PlayerFire` machinegun branch applies `machinegunKick` (latched
  count + kick vectors in/out). `dmOnlyInSP` helper for the web lane +
  1792-absence regression coverage at skills 0-3.
