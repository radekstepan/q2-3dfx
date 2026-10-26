---
"web": patch
---

feat(web): difficulty dropdown, crouch c, doors/ships/flags view (M7.1)

- Difficulty dropdown: `skill` cvar (0-3, default Medium per Q2, latched at
  boot like id's CVAR_LATCH) with Easy/Medium/Hard/Nightmare labels in the
  cvar/menu panel (`CVAR_OPTIONS` + labeled `<select>` in dom.ts). The
  driver calls `SV_SetSkill` before spawning so the server applies the C
  SpawnEntities roster filter, NOT-bit stripping, and easy-half damage
  scale; driver lump parses (monsters, explosives, trigger_always) carry
  the same guard for consistency. Changing skill mid-game takes effect on
  the next boot. Headless tests pin options/labels/mapping plus the
  per-skill server roster (infantry pair on hard+, DM jacket absent in SP,
  low-hole shards always kept).
- Crouch UX: KeyC → `crouch` key and `BUTTON_DUCK` already land via
  `@q2/input` (M5.1); the driver now translates `isDuckHeld(cmd)` onto
  `PMF_DUCKED` before `pmoveFull` (documented input→driver convention), so
  holding C shrinks the hull (maxs 32 → 4, viewheight 22 → 12). HUD + page
  help advertise `crouch C` (with use/attack keys). Note: the host camera
  stays at +22, so the eye does not dip — collision does.
- Doors/trains: DoorSync now covers movers (rest = pos1) and the func_train
  brush (rest = lump origin); `syncDoors` shifts baked verts by
  `ent.origin - rest` every tick, so doors and the exit train visibly
  follow the authoritative server origin. Tests assert exact displacement
  for a fired door and a started train.
- Ships/flags/pickups: ships render from the server trains (live
  `ent.origin`, gated on `started` = SVF_NOCLIENT-cleared), banners from
  the server roster (animated 0..15 at 10Hz), pickups as their C world
  models with EF_ROTATE spin (live edicts only — picked-up items hide).
  All lumps verified present in pak0.pak; the banner skin is the red eagle
  art. The entity path has no PVS/frustum cull (z-test only), so the
  low-hole armor shards at z=-216 render like any other pickup.
- Initial view: exactly two spawn barrels at the lump origins ride
  extraEntities 1:1 (no ghost third); spawn frame submits them to
  renderView. soldier_light/infantry stay unrendered (no lite defs — game
  package territory, reported not edited).
