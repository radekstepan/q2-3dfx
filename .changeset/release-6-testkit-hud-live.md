---
'@q2/testkit': patch
---

RELEASE-6 testkit lane: production-path HUD/F1/completion regressions (src/release-6-hud-live.test.ts). Real server tick + kills/secrets/goals, real SV_FinishLevel, real client execute/blit path with real pak art, real Host frames + resizes; sampled-pixel assertions (icon centers, digit cells, help borders) at 4 resolutions, live-counter updates with no reopen, frozen completion snapshots, (frame&8) flash cadence + ack, no-scoreboard/no-victory guardrails. Asset-free legs always run; real-art legs gate on Q2_PAK.
