---
'@q2/testkit': patch
---

Apply the approved GPU-FOLLOW-5 box-3 proposal: tone-normalized PROOF-4 comparison (CPU reference through overbright x2 + clamp, gamma 1/1.3; thresholds unchanged), explicit TONE-CURVE gate with mistuned-curve negative control, scene mip-dither gate to report-only. The tone-normalized gate still FAILs (F1 99.666%); residual documented as structural, water contributes 0 px in-view.
