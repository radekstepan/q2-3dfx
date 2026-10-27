---
"@q2/game": patch
"@q2/server": patch
---

fix(game,server): C combat numbers, hull-swept bolts, TTK proof (Phase 2)

Game tables vs C ground truth (external/quake-2-source, read-only):
player SP shotgun spread is the literal 500/500 from weapon_shotgun_fire
(not the 1000 DEFAULT_SHOTGUN_HSPREAD, which is the monster arg);
per-skin soldier spawn HP 20/30/40 with C infantry reference data
(100hp, bullet 3/4, melee 5-9). New hull-swept bolt spawn: an embedded
muzzle ejects forward to the first free point instead of detonating at the
gun (thick walls still detonate C-style). Skill audit: easy halves damage
to the player, nightmare has no damage scale anywhere in C (behavioral
only). TTK gate: point-blank blaster kills a basic soldier in <= 4 shots,
600u shotgun aggregate pins the 500 spread.
