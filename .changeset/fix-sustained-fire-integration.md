---
"@q2/game": patch
"@q2/server": patch
---

Two sustained-fire integration fixes. The ss burst died after one round because the per-tick chase re-decision ran before the AI_HOLD_FRAME freeze and re-rolled the frozen fire frame into run (M_CheckAttack cooldown); the tick now skips the chase re-decision while a hold is live (like the duck guard) while locomotion keeps the strafe. And the ss never reached attack4 in the first place: selectAttack returned melee under 80u, but C soldier_attack has no range branch (soldier melee is NULL) — soldiers now always pick their skin gun, ss commits to attack4 at any range. The event label still reads melee under 80u; resolution already keys on the skin weapon.
