---
"@q2/game": patch
---

fix(game): monster facing/anim, authentic bolt life, barrel defaults

Monsters face the player every tick (new MonsterState.yaw in Q2 degrees via
monsterYawTo, id vectoyaw; set by monsterLocomotion even on zero-dist
frames, which still never translate so stand/attack frames cannot moonwalk).
Fix the gunner fire_chain end move: id ends the burst in gunner_refire_chain
(a function, not a move), so the dangling 'refire_chain' end made
monsterMoveOf throw after 8 frames — the chain now exits deterministically
to endfire_chain. Bolt spec verified id-authentic (fire_blaster life 2s,
speed 1000, damage 15 / quad 60, muzzle dlight 200 yellow, no bolt for
hitscan) with the driver contract tests kept green. New explosives tables
(SP_misc_explobox / SP_func_explosive / SP_target_explosion) carry the C
defaults (explobox 10hp/150dmg/mass 400; explosive 100hp/0dmg; explosion
0dmg/0 delay) with a start-room barrel fixture parsed from a synthetic
entities lump.
