---
"@q2/testkit": patch
---

DEMO1 determinism tail (asset-free): scripted tick sequence over the fixed devroom cameras (`src/demo-determinism.ts` — 6 ticks @10 Hz per camera through `SoftwareRenderer` + procedural devroom with style-0 flicker), with per-frame `{camera, tick, time, origin, style, colorHash, indexHash}` records. Tests prove identical reruns, pin all 18 frame hashes, and prove sim-time advancement and style flicker each move the frame. Adds a programmatic §6 completeness gate over every voodoo-baseline manifest entry (map/camera/sim/res/cvars/revision/stage) plus sim-time {0, 1.5, 3} coverage. Documents the light-style gap (baseline captures use static styles=1; styles[1] unobservable on the unlit turbulent banner) in `VOODOO_BASELINE_APPROXIMATIONS.md` §4 and re-pin instructions in the README. No retail assets touched; Q2_PAK-gated paths skip cleanly.
