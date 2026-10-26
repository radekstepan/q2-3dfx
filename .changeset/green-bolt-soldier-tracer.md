---
'@q2/game': patch
---

Fix soldier tracer colors (never green) + machinegun soldier behavior (M7.2). New single source of truth `HITSCAN_TRACER_COLOR = 225` (pak-palette orange, C TE_GUNSHOT family) for the web lane's monster return-fire / shotgun queue call sites (currently 208 green); new `soldierFireEvent()` pins hitscan tracer vs blaster-bolt trail per skin; soldier monster stats/sounds/burst (`solatck3`, 2dmg bullet, 3–10 frame AI_HOLD_FRAME) and `attackMoveFor` machinegun routing.
