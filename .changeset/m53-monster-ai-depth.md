---
'@q2/game': patch
'@q2/server': patch
---

M5.3 monster AI depth (trail pursuit, M_CheckAttack, duck, combat points, skill aggression). Ported from the C ground truth (`g_ai.c`/`p_trail.c`/`m_soldier.c`/`g_misc.c`, behaviour template `quake-2-JS`): player-trail ring + ai_run lost-sight pursuit (last sighting first, then PickFirst/PickNext), M_CheckAttack chance/as-state table with skill scaling + attack_finished cooldown, soldier dodge/duck on incoming projectile fire (skill odds, duck hull, hold frame, duck-and-shoot attack3), point_combat firing positions (spawn/hookup/chain/hold), and skill-scaled aggression (sight delay, burst refire, dodge chance; damage stays half-on-easy). Play-verified: base1-gate (i/j/k) green, (b) gains a planted strafe-battle phase for the authentic ~1/s cadence, (e) aims at the live hull center to track the duck.
