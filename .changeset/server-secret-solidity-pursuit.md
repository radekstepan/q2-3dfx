---
"@q2/server": patch
---

fix(server): secret solidity, monster pursuit (M5.2)

- Secret solidity (BUG 1): the C engine collides the player against
  `MASK_PLAYERSOLID` (`SOLID|PLAYERCLIP|WINDOW|MONSTER`, q_shared.h) but the
  game-side default handed to traces was `SOLID` alone, so player-box traces
  fell straight through the 36 `PLAYERCLIP` detail brushes (stairs/ledges)
  and 7 `WINDOW` brushes base1 seals floors with — including spots where the
  box exits the world volume entirely (e.g. the low-road clip deck by the
  t149 stairs/explosion cluster: mask-1 drops (-500,150) to -600, below
  model0 mins z -464; the C mask lands it on the deck at origin z 120, feet
  96). New server-owned `SV_TraceFor` / `SV_SetPmoveWorldFromBsp` hand in
  the C masks (`MASK_PLAYERSOLID_C`, `MASK_MONSTERSOLID_C`, `MASK_OPAQUE_C`);
  `traceBox` itself is mask-correct (verified by C-vs-1 grid diffs), so no
  `@q2/bsp` change was needed. Secret volumes themselves hold under both
  masks (BFG room lands origin -208, lower corridor -104 — no fall-through).
  Both `func_explosive` slabs were audited: world floor sits beneath *20
  (lands 40) and *30 (lands -220/-168), so detonation opens onto world
  geometry, never a void (id likewise leaves no clip). `SV_SpawnEntities`
  now records solid brush clips for `func_explosive` / `func_wall`
  (`SOLID_BSP` until destroyed, g_misc.c) with `SV_RemoveBrushClip` opening
  them and `SV_ClipTrace` combining them with the world for drivers; the
  scripted traversal driver keeps its legacy mask-1 hookup (its low-trench
  route passes under the decks) while the new clip-deck tests pin C-mask
  behavior.
- Monster pursuit (BUG 2): the start-room soldier acquired and fired but
  never advanced — `SV_MonsterTick` ran line of sight knee-to-knee at the
  wrong mask while C `visible()` checks eye to eye (monster +25, player +22)
  against `MASK_OPAQUE`, and locomotion had no `SV_movestep` stair climb, so
  any riser wedged the hull (uphill corridor: ~2u per 60 ticks, gap never
  closes). `SV_MonsterTick` now sights eye-to-eye (optional opaque-mask
  `sightTrace`, duck-height override) and steps the locomotion hull with a
  C-style lift-18/move/drop-36 climb. The runner test now pins sustained
  pursuit of a moving target: with a deterministic never-attack RNG double
  isolating locomotion, the chaser climbs the corridor stairs and closes
  96→23 on a strafing player (pre-fix build fails the same test).
