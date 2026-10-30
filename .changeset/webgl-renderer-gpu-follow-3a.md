---
'@q2/webgl-renderer': patch
---

GPU-FOLLOW-3A (renderer lane): add explicit `clearSkyStrip` for map-change to the flat fallback. Deletes the obsolete same-context strip texture before dropping ownership (never GC-relied); after loss the handle is just dropped. Re-registration stays idempotent via the existing lazy single-upload path. Adds a lifecycle pin: register → clear is warning-free with null dims, re-register restores the strip.
