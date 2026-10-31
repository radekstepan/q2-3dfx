---
'@q2/server': patch
'@q2/game': patch
'@q2/testkit': patch
---

RELEASE-5 (game+server+testkit lane): monster-vs-body collision, wall-climb guard, infantry fire audit. SV_MonsterTick moves on a per-monster trace (other live hulls + player box, self-skipped; corpses still pass through); locomotion freezes under AI_HOLD_FRAME; infantry smack is flashless and the swing plays infatck2; burst-expiry float dust fixed (infantry n-6, soldier k+1). Real-base1 regression at (-1148.1,1542.3,-24) replaces the constant-assert pin: t38 pursuit holds floor level, crosses only through the opened *19 doorway, never ghosts the closed slab.
