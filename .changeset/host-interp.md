---
"@q2/host": patch
---

fix(host): interpolate local-player origin between 10Hz ticks (feedback follow-up)

- `renderCurrentView` used the stepped `playerOrigin` (refreshed from `driver.snapshot()` only on ticks) while angles came fresh from `lastCmd` every frame — camera position stepped at 10Hz (slideshow) while look stayed smooth. It now renders at the continuous clock `serverTime + serverAcc` with the local origin taken from `predictor.renderEntities` (constant-velocity sweep across each tick); 10Hz sim untouched, offline mode unchanged. Regression test pins per-frame-unique, small, monotonic view steps.
