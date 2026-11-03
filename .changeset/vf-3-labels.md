---
"@q2/voodoo": patch
---

VF-3: fix approximation-profile provenance labels (no behavior change). scanout.order is now approx:chosen with the video-proc vs RAMDAC inference note (PG §6.5.3) and video-processor wording; matched-pairs drops "only" and records the PG §17.8 3-bit-tap alternative (scope in VF-6); lod.dither-mean moves to manual:textureMode (PG §9.3.58 bit 4) with new approx:chosen entries for the Bayer-threshold pick, 8-bit bilinear weights, and box mip kernel; all guide §4 citations re-anchored (depth → fbzMode §9.3.31 + §10.4.2/Table 10.7, texture → textureMode §9.3.58); "trilinear" renamed to dithered single-level selection (NOT PG two-pass trilinear).
