---
'web': patch
'@q2/server': patch
---

fix(web,server): throttle in-canvas fps readout, single-draw help background, drop duplicate secret hold case

- Web play loop (`apps/web/src/dom.ts`): the in-canvas `fps N` readout now refreshes at most twice per second (500ms `displayFps` latch) so it stays readable. The per-frame EMA still updates every frame and feeds `publishQ2Stats`; only the value painted by `drawPlayHud` is throttled.
- Web help overlay (`apps/web/src/play.ts`): the `help` background is drawn exactly once via the `xv 32 yv 8 picn help` statusbar row. The manual centered pre-draw duplicated the bottom border 16px lower, so it now only paints a fallback panel when the art is missing (devroom) at the same layout origin the rows expect.
- Server secret doors (`packages/server/src/doors.ts`): remove the duplicate `case 'hold'` from the no-op `idle/open` trailer in `secretThink` — the real `hold` wait (`waitUntil` -> `return`) is handled above, so the dead duplicate label is dropped.
