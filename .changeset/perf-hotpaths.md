---
'@q2/sw-renderer': patch
---

perf(sw-renderer,web): hot-path pass + browser async render toward 60fps

Serial hot path (all byte-identical, goldens green): per-surface cull now
reads a once-per-frame flat frustum (`culledByFlatFrustum`, 200k-case fuzz
vs the object path), the lightstyle hash is memoized per lightmap per
frame, and the world-light affected-list lookup is a binary search over the
already-sorted list. Interleaved OLD×3/NEW×3 on base1 spawn-north 640×480:
GEO 15.2→13.4ms, frame ~35→~29ms, hashes identical. Also probed and
reverted two non-wins to keep the diff honest: a SpanList batch window
(the pool is reused per batch, so the window was a no-op) and a reciprocal
hoist in the emitter (broke `8f61c755` — the emitter stays fp-exact).

Browser async (M7.1 box): `renderViewAsync`/`endFrameAsync` (deferred
fused kick + async resolve, identical planes/stats), `BrowserBandPool`
(DOM Worker pool over the shared SAB protocol) + worker entry,
`frameAsync`/`stepAsyncSim`/`buildAsyncView`/`attachBrowserPool` in
`apps/web` with a headless differential test (frameAsync ≡ host.frame
pixels + sim over 30/60 scripted frames), `resolveDisplay` now sources the
live renderer color plane (pooled/wasm correctness), and a committed
play-level bench section (10Hz tick / pumps / host render / HUD /
blit-copy estimate). M9.1 closed as composition-supersedes (see BRAIN.md).
