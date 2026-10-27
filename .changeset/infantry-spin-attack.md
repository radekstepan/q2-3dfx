---
"@q2/game": patch
"@q2/server": patch
---

feat(game,server): infantry spin/cock + full combat loop

Answer to the feedback question: yes, the spin is real — m_infantry.c `infantry_cock_gun` (attack1 frame 4, attak104 = md2 187) plays `infantry/infatck3.wav` and arms a 1.0–2.5s pausetime burst; it is the chaingun spin/crank wound up before the `infantry_fire` shot at attak111 (md2 194), not an attack2 wind-down. Catalogue audit of the full C combat behavior:

- attack1 (attak101-115): cock at index 3 + aimed InfantryMachineGun at index 10 with AI_HOLD_FRAME re-fire (3–18 round burst across the cock pausetime).
- attack2 (attak201-208): swing (infatck2.wav, no damage) at index 2, smack (5+(rand%5) kick 50, melee2.wav) at index 5.
- death2 (death201-225, "Off with his head"): blind 12-round InfantryMachineGun spray on death211-222 (md2 155–166) through aimangles[] with flashes MZ2_INFANTRY_MACHINEGUN_2..13 — the only armed infantry death move (the old "infantry deaths never fire" comment was wrong for death2; death1/death3 are all NULL).
- duck (infantry_dodge 25%, hull shrink + hold), pain (2 moves, skin change at half HP, none at skill 3), fidget/idle — already present or cosmetic; unchanged.

Implemented in-lock: `INFANTRY` tables tag 'cock'@3, 'fire'@10, 'swing'@2, 'melee'@5, and 'fire'@10–21 on death2 (C frame numbers cited in comments); `deathFireEvent` handles the infantry death2 spray as a skin-gun machinegun event through the live resolver (muzzle + tracer + infatck1 + dmg 3, unconditional like C). Headless pins: attack1 pass emits exactly one machinegun event on frame 10 with full resolution evidence; death2 emits 12 spray events resolving to 12 foe muzzles/tracers/sounds and 36 damage. Honest gap reported for the server owner: the cock sound (infatck3) and the AI_HOLD_FRAME burst repeat need a tick call-site in packages/server/src/index.ts (outside this lane's lock) — the cock frame currently emits nothing rather than a fabricated bullet.
