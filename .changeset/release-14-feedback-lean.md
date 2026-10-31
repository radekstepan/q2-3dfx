---
"@q2/game": minor
"@q2/server": patch
"@q2/client": patch
---

RELEASE-14: source-faithful damage feedback arithmetic and strafe view lean. Game adds the `P_DamageFeedback`/`SV_CalcRoll` port module (blend mix, alpha accumulation/decay, directional kick, velocity/bob lean); server records player-damage totals + attacker origin with a one-shot drain; client adds an alpha-composite rect for the damage wash; the web driver runs the per-tick feedback state machine with the overlay painted once post-resolve on both renderers.
