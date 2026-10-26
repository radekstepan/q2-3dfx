"@q2/sw-renderer": patch
---

fix(sw-renderer): pooled band path no longer renders black sky at angles

`BandWorkerPool.dispatch`/`dispatchAsync` staged surface textures into the
64KB shared slot with no size check: any texture larger than `TEX_CAP`
(the packed 256x1536 unit1_ sky strip is 384KB) was silently truncated,
so worker threads sampled zero-filled staging past 64KB as palette index
0. The rt tile (first 64KB) rendered fine while bk/lf/ft/up/dn came out
completely black — sky black at every angle not facing +X. The WASM
backend already rejects oversized textures to its TS fallback; the pool
now mirrors that guard (`stagingFits`, same `TEX_CAP`/`LIGHT_CAP` caps,
now exported from bands.ts): unsuitable batches return null and run
inline, bit-identical. Pinned by a pooled-vs-classic all-six-faces sky
test with a real-size strip plus a Q2_PAK spawn yaw-sweep asserting no
clear-black pixels where the flat path shows sky.
