---
'@q2/testkit': patch
---

GPU-FOLLOW-5: repair the degenerate PROOF-4 far/mip fixture and strengthen lifecycle evidence. The shipped far gate is fed by the FAR_VIEW capture (was near-camera 0/0, now 0.9937) and the shipped mip gate by a new same-MID-camera on/off pair (valid minified view, 0.961 nonblack, 0.987 vs near); thresholds unchanged — the still-0 mip count fails loudly as a fixture-regime miss, never loosened. Adds matched F0/F2 CPU/GPU captures (same scene/time/cvars rule), a gun-skin-withheld negative control (white fallback + missing-skin warning, gun-bbox-localized), a dual-chunking fetch determinism pin, and follow2b evidence in gate artifacts. F0/F1/F2 vs-CPU rows are report-only; the 0.02 fidelity gate and human sign-off stay pending.
