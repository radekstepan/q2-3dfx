---
'@q2/server': patch
---

RELEASE-4 server lane: fix two C-parity collision defects blocking the exit approach. sweepBrushBox now ports id's "completely in front of face" early-out so clips behind the walk direction miss instead of reporting fraction-0 phantoms, and startsolid comes only from the inside test. func_button travel is |movedir| . size - lip per SP_func_button (pressed *34 sits flush instead of 1 unit proud pinning walkers). Adds a real-base1 regression walking hall to walkway with no phantom obstruction plus the scripted pmove-rider board/ride/park proof (setup teleport documented).
