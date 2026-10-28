---
"@q2/testkit": patch
---

Working voodoo baseline (no HW calibration): deterministic synthetic scenes (flat, ramp, checker, red/blue lit wall, transparent hole, high-contrast edge) plus a procedural devroom serial-path render, each captured raw RGB565 and reconstructed at 640x480 with profile-settings JSON sidecars. Commits `baseline-manifests/voodoo-baseline.json` (hashes + settings, no pixels); blobs regenerate into gitignored `test-output/voodoo-baseline/` via `yarn workspace @q2/testkit baseline`. Adds `VOODOO_BASELINE_APPROXIMATIONS.md` (manual-sourced vs chosen-approx split) and gates: raw-vs-recon differ on dithered gradients, agree within one 565 quantum on flat fields, profile JSON round-trips, web-shell hooks feature-checked without importing apps/*.
