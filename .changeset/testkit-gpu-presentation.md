---
"@q2/testkit": patch
---

GPU-FOLLOW-0: production-page presentation regression. New `gpu-presentation` harness drives the real `apps/web` page (vite dev + soak boot query, no synthetic page, never imports `apps/*`) over CDP and asserts the composed visible page: `#q2` background transparent in GPU mode (opaque black fails closed), `#q2`/`#q2-gl` bounding-rect equality within 1px, WebGL2 context health, per-leg `Page.captureScreenshot` scene pixels (non-black floor, gun-region floor, near-white ceiling, distinct-triple floor — all-black screenshots fail as a presentation gate, not a headless artifact), and no page exceptions. Covers boot + CPU→GPU→CPU switching at 640x480 backing plus a small-viewport GPU leg, with pure PNG/rect/color helpers unit-tested headless.
