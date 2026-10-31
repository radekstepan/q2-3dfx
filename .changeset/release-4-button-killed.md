---
"@q2/server": patch
---

RELEASE-4: C `button_killed` parity — blaster bolts damage health-gated `func_button` brushes (damage XOR impact flash, like `blaster_touch`), so base1's health-1 lift-call button (*13 → t91) fires when shot, the original-supported interaction. Lethal hits restore health and fire via `SV_UseMover`; health-less buttons still spark. Also narrows the port-invented `lift` finish to the one-way train-call button (the transient *34 → t4 plug cycle no longer finishes, since that press is unreachable in play).
