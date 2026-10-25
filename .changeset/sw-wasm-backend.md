---
'@q2/sw-renderer': minor
---

M9.1: WASM spanfill backend (`WasmSpanBackend`) behind the `sw_wasm` cvar (default 0 = TS path).

- Ports the `drawSpansSoftware` opaque-span inner loop (16-pixel affine
  subdivision, §7.1) to a dependency-free WebAssembly module whose bytes are
  built at runtime by a tiny emitter in `src/wasmSpans.ts` (no toolchain was
  available in this env: no AssemblyScript, wat2wasm, clang-wasm, or Zig —
  opcodes were verified empirically against V8 with probe modules).
- Byte-identical to the TS path: 200-iteration differential fuzz, pinned
  devroom golden (`8f61c755`), and 4 real base1 views (Q2_PAK-gated) all match
  exactly. Out-of-range inputs (non-pow2 textures, grades outside 0..63,
  tiny batches) take the TS fallback, so output can never diverge.
- Measured (Ryzen-class box): synth spanfill 108.6 → 157.6 Mpixel/s
  (**1.45×**, 0 diffs); real base1 640×480 paired A/B at parity
  (22.95 vs 22.90 ms/frame — frames are dominated by non-spanfill work, and
  the 256-px batch threshold routes small batches to TS). The card's ≥2×
  needs SIMD v128 (or M8.1 worker banding); the scalar port documents that
  ceiling. TS remains the default; `main` stays green.
