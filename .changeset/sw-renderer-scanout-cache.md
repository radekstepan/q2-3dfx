---
"@q2/sw-renderer": patch
---

fix(sw-renderer): RGB chain staging ownership + parallel voodoo scanout (Track A)

Phase 0 ownership: stageRGB no longer evicts the persistent chain cache while
descriptors are pending (pending slot refs would be corrupted). Refuses to
stage instead (caller replays pending inline first); evict-and-retry only
when nothing is pending. Pinned by rgbStageEvict.test.ts (fills the 8 MiB
chain region while 32 batches are pending: bytes preserved, pending intact,
next-frame eviction succeeds).

Track A parallel scanout: banded fused pack→recon→gamma (processScanoutBand)
byte-identical to voodoo resolveFusedFrame across all reconmodes, dither
on/off, 2x2/4x4, postfilter, gamma, quantise off, odd dims and 1/2/3/7-band
splits (halo packed locally, disjoint writes, absolute dither phase,
immutable input). Node BandWorkerPool flushScanout/flushScanoutAsync +
worker-loop JOB_SCANOUT; SAB extended with shared scan565/scanDisplay.
Pinned by voodoo scanoutBand.test.ts + scanoutPool.test.ts (real threads).
Base1 640×480: serial resolveFrame ~33.8 ms → pooled flushScanout ~14.8 ms
(2.3×), synthetic 31.3 → 8.8 ms (3.5×), byte-identical.
