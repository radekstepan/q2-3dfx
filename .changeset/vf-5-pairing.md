---
"@q2/voodoo": patch
"@q2/config": patch
---

VF-5: keep vd_dithermode default 4x4 under 2x2sub+2x2box scanout as an accepted mismatch. PG fbzMode 9.3.31 2x2 note covers "some 3Dfx software", unverified vs MiniGL; separate registers tolerate the mismatch and the flip would break appearance pins plus goldens. Profile scanout.default entry and vd_dithermode/vd_reconmode cvar docs record the rationale; no golden re-pinned.
