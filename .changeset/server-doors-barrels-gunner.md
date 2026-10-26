---
"@q2/server": patch
---

fix(server): doors start closed/autoclose, barrel grounding, gunner audit (M5.2)

- Doors: `SV_TouchDoorsAt` now takes a toucher class and enforces the C
  `DOOR_NOMONSTER` gate (`Touch_DoorTrigger`, g_func.c), so monsters open
  plain doors (*19/*31) but never the *32/*33 sliders. Spawn state verified
  unchanged and pinned: no `START_OPEN` in base1, all four movers rest at
  pos1/`bottom`, touch opens, and a clear area + elapsed `wait` latches back
  at pos1/`bottom` (the C `door_hit_top` → `door_go_down` → `door_hit_bottom`
  cycle; the previous code already closed correctly — no spawn-at-pos2 path
  exists, so the reported open-at-spawn render is not server state).
- Barrels: the two z=0 `misc_explobox` lump origins trace to floor z≈0.03
  (1/32 C `DIST_EPSILON` contact) and overlap neither `func_wall` glass slab
  (*9/*10, hundreds of units away) — spawn grounding is correct; any visible
  float is the render-side MD2 origin (web lane).
- Gunners: `monster_gunner` count is 0 at every skill; the exit
  `weapon_machinegun` is spawnflags 1792 (inhibited at all SP skills, spawns
  in DM per the g_spawn.c DM branch). Soldier spawns now stash the C skinnum
  (`_light`→0, normal→2, `_ss`→4, m_soldier.c) on `edict.extra` so the render
  lane can distinguish blaster/shotgun troops.
