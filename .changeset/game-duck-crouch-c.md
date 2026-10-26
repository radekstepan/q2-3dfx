---
'@q2/game': patch
'@q2/client': patch
'@q2/host': patch
---

Fix crouch end-to-end (M5.1): `PM_CheckDuck` now honors C `upmove<0`-on-ground plus the `BUTTON_DUCK` bit-8 hold (KeyC), with headroom-checked stand-up; ducked camera dips to +12 via `calcViewOrigin(origin, ducked)`.
