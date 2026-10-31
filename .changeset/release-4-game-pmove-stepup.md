---
'@q2/game': patch
---

RELEASE-4 game lane: pmove-side boarding audit proves the obstruction is server-collision-side (pmove matches C StepSlideMove/STEPSIZE/ground rules; real base1 deck/floor deltas measured). Adds a pmove-level step-up regression pinning C-exact train-deck semantics (boards at STEPSIZE 18 and below, refuses above, no teleports). Test-only; no production behaviour changed.
