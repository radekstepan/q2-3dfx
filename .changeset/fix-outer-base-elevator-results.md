---
'@q2/server': patch
---

Fix Outer Base elevator boarding and completion. The platform waits at the
entrance while the doors open. Using the back switch from aboard closes the
doors, carries the player down, and finishes the level at the bottom. The web
app freezes the simulation and automatically displays the F1-style results
panel with the final level totals.
