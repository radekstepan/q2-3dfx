---
'@q2/testkit': minor
---

GPU-FOLLOW-3 lane C: live arsenal + required-effects coverage oracle. Adds `gpu-effects-semantics` — supported weapon/enemy/pickup catalogs (by value), `Follow3LiveCapture` observation shape for the apps/web lane (by name), combat-event drain gate, CPU-derived effect oracle (SoftwareRenderer pixel floors + selector submission floors), and the combined `validateFollow3Coverage` gate. GPU-resident HUD stays optional (report-only note). Integrator merge fix: `gpu-boundary` entity-kind pins now match refs by index-stable `surfaceId` slot instead of position (tracers ride the blend pass far→near, so order is a draw sequence while identity is the slot).
