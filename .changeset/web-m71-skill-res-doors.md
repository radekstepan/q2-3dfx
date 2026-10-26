---
'web': patch
---

feat(web): skill reload, resolution dropdown, doors/glass/tracers/skins (M7.1)

- Skill dropdown reboots the level at once: the cvar panel notifies the
  browser boot, which re-calls the boot path so `SV_SetSkill` applies before
  spawning (no more wait-for-next-map latch).
- Resolution dropdown (`vid_resolution`: 320×240/640×480/800×600/1024×768):
  latched like skill, reboot resizes the internal framebuffer + canvas
  (CSS upscale stays ×2). Persisted via setCVar.
- Doors render CLOSED at spawn: QBSP submodel faces sit in no node range or
  leaf facelist, so every brush entity was invisible. The driver grafts
  mover/train/func_wall faces into the leaves they intersect (travel
  unioned), baked at the mapper (closed) pose with the existing
  `ent.origin − rest` DoorSync displacement.
- func_wall *9/*10 render (opaque: the lump carries no `alpha` key).
- Hitscan tracer color 208 → 225: 208–214 is GREEN on the engine palette
  (game-lane audit, `isGreenBoltColor`); 225 is the C-correct yellow core.
  No queued beam may use 208–214 (pinned).
- Per-skin soldiers: light (skin_lt/blaster/foe bolt), plain
  (skin/shotgun/single tracer), ss (skin_ss/machinegun/3-round burst +
  solatck3). All base1 soldiers placed (light was skipped before).
- Barrel audit: the MD2 pivot is the box bottom (frame min-z ≈ 0) and extras
  mirror lump origins 1:1 — no view-side lift; pinned by test.
