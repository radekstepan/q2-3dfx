---
'@q2/game': patch
'web': patch
---

Re-export the game-owned `HITSCAN_TRACER_COLOR` (225) from the web driver instead of a view-side duplicate, so the green-laser fix has a single source of truth.
