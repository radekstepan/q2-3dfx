---
"@q2/server": patch
"@q2/game": patch
"web": patch
---

fix(server,web): explodable window renders as brush, dead soldier corpse

World-content lane (2 items):

A. The spawn-room "third barrel" is func_explosive *20 (lump: 2
`misc_explobox` + 1 `func_explosive`, *20 + *30). Barrel MD2 proxies now
render ONLY for genuine `misc_explobox` edicts; both func_explosives
render their brush models via the mover graft (DoorSync + leaf facelists,
like doors/func_walls) and are stripped from the leaves when blown
(`hideFreedBrushes`). Damage path unchanged (commit e2227bb kept): clip-
attributed touch fuses the brush, radius uses the C CanDamage self-hit
rule, killing all 3 still chains the opener. *20 is all-TRANS33
`e1u1/wndow0_3` glass (flags 0x10 on all 17 faces); it renders through the
same world path as all base1 glass (no C spawnflags on either brush, so no
extra spawnflags handling — TRIGGER_SPAWN/EF_ANIM inapplicable).

B. `misc_deadsoldier` spawns per C (SOLID_BBOX 32x32x16, MOVETYPE_NONE,
SP-only; takedamage/deadflag have no Edict fields and no clip entry
consumes the bbox, so corpses persist as scenery) and renders the deadbod
dude MD2 (`models/deadbods/dude/tris.md2` + `dead1.pcx`) at each lump
origin + yaw with the C pose frame (spawnflags bits → 1..5, else 0 —
`deadsoldierFrameForSpawnflags`). Base1 fields 12; all 12 submit every
frame, including the door-debris corpse (40,272,-64, frame 1).

Play-verified: base1-gate grows to 16 tests — new (o) pins the *20 lump
inventory + TRANS33 faces + closed-pose graft + no barrel proxy + kill →
clip open + faces ungrafted (*30 control stays), new (p) pins the 12-
corpse lump inventory + server bbox state + per-corpse origin/frame/yaw +
persistence. Updated pins: (g) graft 232 → 332, (n) barrel roster 11 → 9.
