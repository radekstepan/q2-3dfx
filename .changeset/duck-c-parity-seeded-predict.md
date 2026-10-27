---
'@q2/game': patch
'@q2/client': patch
'web': patch
'@q2/server': patch
---

C-parity duck gating (`PM_CheckDuck`: hold + `ON_GROUND`, no sticky self-sustain; airborne hold stands) and seeded prediction state (`pmFlags` + `grounded` flow snapshot → replay, so ducked prediction matches the authoritative tick).
