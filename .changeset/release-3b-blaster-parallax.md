---
"web": patch
---

RELEASE-3B blaster aim: document intended muzzle parallax and pin it with a production regression. No renderer or simulation change — `SV_PlayerFire` spawn/dir already match C `G_ProjectSource`/`Blaster_Fire` (24 fwd + 8 right + viewheight-8, dir = forward). New `blaster-aim.test.ts` captures actual server bolts at near/mid/far, level/pitched views, 3 resolutions, CPU+GPU projections agreeing <1px, wall-impact parallelism and kick transient, with zero-muzzle/convergent negative controls.
