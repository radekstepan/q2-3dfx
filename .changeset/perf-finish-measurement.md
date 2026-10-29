---
"@q2/testkit": patch
---

PERF-FINISH-C measurement integrity: full-RGBA serial-vs-pooled raster and
final-display parity (blue/alpha corruption caught by fail-before pins),
RGB raster/scanout execution proof, Voodoo raster+scanout fallback tests,
corrected RGB-enabled translucent gate, skybox+ordinary same-skip-policy
pins, ESM/CJS config-store contract test. Timing-sensitive acceptance stays
in tools/bench bench:accept; unit tests cover only deterministic comparison.
