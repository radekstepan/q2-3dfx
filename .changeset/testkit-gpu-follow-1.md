---
"@q2/testkit": patch
---

GPU-FOLLOW-1 testkit pins: add pure gpu-acceptance validators (fixed 0.02 fidelity gate, coverage/displayed predicates, separated report) wired to compareGpuProofFrames via validateGpuProofDiff, with hermetic pin tests. Fidelity 0.912-vs-0.02 stays FAIL, never reclassified as PASS.
