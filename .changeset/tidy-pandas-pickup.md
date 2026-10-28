---
'@q2/game': patch
'@q2/server': patch
---

Fix base1 item pickup gaps + monster solidity state (C-parity, g_items.c / g_monster.c / p_weapon.c / cl_fx.c)

- `@q2/game`: ITEMS gains the missing base1 rows — `item_silencer` (banks +30 `silencerShots`, stacking like C `Use_Silencer`), `ammo_grenades` (5, cap 50), the full weapon table (supershotgun/chaingun/grenadelauncher/rocketlauncher/hyperblaster/railgun/bfg with SP damage/ammo-per-shot), `item_quad`/`item_invulnerability` (30s `quadUntil`/`invulnUntil`), `item_adrenaline` (max+1 + heal) / `item_ancient_head` (max+2), and all nine `key_*` carry rows. Weapon pickups grant the C `Add_Ammo` quantity per ammo kind (shells 10, bullets 50, cells 50, rockets 5, slugs 10, grenades 5) clamped to that ammo's max carry; `findWeapon` resolves the full arsenal; powerup respawn delays are the C quantities (invuln 300, rest 60).
- `@q2/server`: monsters spawn `SOLID_BBOX`/`MOVETYPE_STEP` (TRIGGER_SPAWN dormants stay `SOLID_NOT`/`NONE`), wake re-solidifies, death clears solid (C `SVF_DEADMONSTER` movement skip); items link `SOLID_TRIGGER` at spawn (C `droptofloor`); new `SV_MonsterClipBox` helper + opt-in `SV_ClipTrace` monster pass (`includeMonsters`, C `SV_ClipMoveToEntities` with `ignoreNum` passedict — default off so the shared driver trace never self-freezes movers); per-weapon `playerFireSound` table from the client `MZ_*` cases. Skill inhibit unchanged and respected throughout (1792 rows absent in SP, 769-flagged infantries at skill 2+ only).
