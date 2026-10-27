---
'@q2/server': patch
---

Fix func_explosive damageability and the blown-door path (server sim).

- `SV_ClipTrace` now attributes a winning brush clip to its edict
  (`entityNum`, the C `trace.ent` for SOLID_BSP), so bolt, pellet and
  radius code resolve touches against the brush edict itself.
- Blaster bolts and shotgun/machinegun pellets that stop on a live
  func_explosive clip damage the brush (barrel_delay fuse) instead of
  detonating harmlessly on an anonymous wall. The old clip-vs-damage-bbox
  tie always resolved to the wall, leaving func_explosives undamageable
  by direct fire.
- `SV_RadiusDamage` ports the C `CanDamage` MOVETYPE_PUSH self-hit rule
  (a trace ending inside the target brush counts) and skips `points <= 0`
  falloff (a dmg-0 blast chips nothing, per g_combat.c).
- Net effect (C parity): shooting barrels chains into nearby func walls
  (base1 opener: spawn barrels blow the *20 wall), blown walls remove
  their clip, the corridor walks open, debris stays visual-only.
