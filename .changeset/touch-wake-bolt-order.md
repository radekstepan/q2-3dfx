---
"@q2/server": patch
"web": patch
---

Touch regressions: unkillable barrels, dormant followers, wrong infantry look

- `@q2/server` bolt touch is nearest-wins (g_phys.c FlyMissile +
  ClipMoveToEntities): the old wall-first order detonated on any wall inside
  the 100u step even when a barrel or monster stood closer — two base1
  exploboxes were unkillable with the blaster from range and foe bolts
  fizzled past the player. The SURF_SKY silent free now applies only when
  the wall actually wins the step.
- `@q2/server` TRIGGER_SPAWN wake/use chains (g_monster.c): dormant bodies
  are SOLID_NOT + invisible until used; Touch_Item fires the item's target
  once (shotgun -> t55), monster_death_use fires the victim's target
  (t39 -> t40), and any use by targetname wakes/alerts live monsters. The
  t55 shotgun trap now releases both soldiers, which pursue and fire.
- `web`: dormant monsters leave the snapshot (SVF_NOCLIENT) until woken;
  the shotgun pickup fires its target; infantry renders on its own MD2 +
  skin instead of the soldier mesh (wrong-pose reports).
- Gate: (h) pickup wakes the t55 pair and it closes in (rendered verdict);
  (e)/(f) re-pinned to awake bodies (old counts included dormant statues).
