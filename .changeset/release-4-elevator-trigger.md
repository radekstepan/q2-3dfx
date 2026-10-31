---
'@q2/server': patch
'@q2/game': patch
---

RELEASE-4 (server+game): C-parity final-elevator trigger/state/timing. Targetname/health doors spawn no touch trigger (id SP_func_door), so base1's *31 plug no longer drops on approach and waits for its *34 (t4) press; func_button default wait corrected to the C value 3. Real-base1 tick-loop regressions pin lump identity, approach/park, no premature departure, *34/*13 button use, train ride with corner waits, repeat use and blocked rules, plus a pmove-rider boarding proof.
