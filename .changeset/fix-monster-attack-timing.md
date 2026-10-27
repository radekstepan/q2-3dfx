---
'@q2/game': patch
'@q2/server': patch
---

fix(game,server,web): reconcile monster attack timing — closes-then-engages is C-correct

The devroom engagement tests pinned the pre-depth opener geometry (first
volley from 200u+, live cross-tick bolts, muzzle 100u+ from the eye). The
C cadence (HuntTarget 1s hold + M_CheckAttack NEAR 0.1/frame against the
~122u/s soldier run) closes to NEAR/melee before the first volley, so the
tests now assert closes-then-engages explicitly: blind legs hold `run`
with no shot, sighted monsters close 50u+ then plant volleys at melee
(where the foe bolt crosses the muzzle→eye gap within its first 60u step,
exactly like G_RunFrame's same-frame edict processing).
