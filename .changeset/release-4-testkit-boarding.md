---
'@q2/testkit': patch
---

RELEASE-4 testkit lane: real-base1 boarding trace diagnostic for the waiting final elevator. Sweeps the walking approach plus step-off drops asserting passage with per-ray fraction/startsolid/allsolid/entityNum, pins rendered-vs-collision pose within 1e-6, asserts no premature departure with waiting preserved, and carries a pre-fix sweepBrushBox mirror naming the phantom blockers. Skips cleanly without Q2_PAK.
