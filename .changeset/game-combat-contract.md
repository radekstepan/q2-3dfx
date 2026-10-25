---
"@q2/game": patch
---

test(game): pin close-range soldier combat contract (feedback follow-up)

- New `monster-combat.test.ts`: `monsterRange(50)` is `RANGE_MELEE`, `selectAttack('soldier', …)` never idles at close range, and a 20-tick simulation of the documented combat decision (LOS clear, ≤1000 gate, ~1/s limit) deals exactly 20 damage in 2s. Headless repro (devroom + real base1 via `Q2_PAK`, incl. full `Host.frame` loop) deals damage end-to-end — no game-layer defect found; the test guards the contract against regressions.
