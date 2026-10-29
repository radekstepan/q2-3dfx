# GPU-PROOF-1 — baseline + fidelity contract (2026-10-29)

> Pre-implementation contract for the bounded WebGL2 proof (BRAIN.md §8
> GPU-PROOF-1–5). Written BEFORE any GPU code exists. CPU-to-CPU parity
> stays hash-exact; every tolerance below is a human-review gate for
> future GPU-vs-CPU comparison, never an auto-pass.

## 1. Starting tree + ownership handoff

- Starting commit: `8608859` (`chore: webgl`, BRAIN-only delta on top of
  `ddd8124` PERF-NEXT-6 round-1). Tree was **clean** at card start
  (`git status --porcelain` empty); engine code at `53f7070 ==
  4631ca2` per PERF-NEXT-1, plus the integrated PERF-NEXT-2–6/9 lanes.
- In-flight work at start: two parallel lanes (testkit gpu-proof
  harness, bench gpu-proof gate) under §7 disjoint `owns:`; no other
  CPU agents were active (PERF-NEXT-6/7/8 + PERF-FINISH-A/B/C are
  `paused` by the user-directed pivot and were not resumed).
- Preservation rule: the software renderer is the authoritative CPU
  reference. GPU-PROOF-2–5 must not change its output, goldens, or
  Node-test behavior. Any shared-policy extraction (voodoo constants,
  LOD helpers) copies pure values into the GPU backend; the CPU path
  keeps its own copies and pins.

## 2. Fixed proof scene + route

Canonical definition: `packages/testkit/src/gpu-proof.ts`
(`gpuProofRoute`, `gpuProofPerfRoute`); bench duplicates by value with
a canonical pointer (`tools/bench/src/gpu-proof.ts`).

- Map: real shareware `base1` (`maps/base1.bsp` + WALs +
  `pics/colormap.pcx`), Q2_PAK-gated, never committed.
- Camera: spawn-north — origin `[128,-320,54]`, yaw `90`, pitch `0`,
  `fovX 90`, `time 1.5`, `lightStyles` flat `1.0`. 640×480.
- Fidelity profile: pinned `BENCH_FIDELITY_CVARS` shared **by reference**
  (`GPU_PROOF_FIDELITY_CVARS === BENCH_FIDELITY_CVARS`): `vd_gamma 1.3`,
  `vd_dither 1`, `vd_16bit 1`, `vd_postfilter 1`, `vd_bilinear 1`,
  `vd_mipdither 1`, `vd_lodbias -0.35`, `vd_fog 1`, `vd_overbright 1`,
  `vd_palettetex 1`, `vd_maxtexsize 256`, `vd_zbits 16`,
  `vd_dithermode 4x4`, `vd_reconmode 2x2sub+2x2box`,
  `vd_rgbmaxdelta 8,8,8`, `sw_workers 0`, `sw_accum 0`.
  NOTE: `vd_lodbias -0.35` is the current pinned profile;
  VOODOO-REPAIR-2 reassessed alias bias to `0` post-fix — if the bench
  lane moves the profile, the proof route moves in the same change and
  reference hashes are re-recorded.
- Fixed 3-frame route (acceptance + fidelity):
  - **F0** `gpu-proof-f0-stationary`: stationary workload, fixed camera,
    fixed entity set (soldier MD2 frame 4 + sprite + tracer beam).
  - **F1** `gpu-proof-f1-combat`: combat workload, same camera — fixed
    set + eye-anchored depthHack viewmodel gun (`v_blast` frame 4) +
    muzzle/boom dlights re-pumped per frame + 12-spark particle cloud.
  - **F2** `gpu-proof-f2-moving`: moving combat, rep 3, yawStep 2 →
    yaw `96` (same combat set + lights + particles).
- Perf route (GPU-PROOF-5 reuse): 60-frame moving combat, reps 0–59,
  yawStep 1° (`gpuProofPerfRoute`).
- Reuse rule: entity placement/light pump math lives in
  `bench-workloads.ts` (`fixedBenchEntities`, `combatBenchEntities`,
  `pumpBenchLights`); the proof module calls them, never duplicates
  offsets. No synthetic acceptance scene.

## 3. GPU fidelity contract (pre-implementation)

Exact asset/UV orientation: WAL texels sampled in texel space
(`u = dot(p, texinfo.s)/scale + off`), MD2 skins through the palette,
colormap shade via the 64×256 table; V coordinate orientation follows
the CPU reference (any GPU flip is a bug, not a tolerance item).

Scene content per frame: §2 route (opaque world + sky/flat-sky batches
where frustum-visible, depth-tested world surfaces, textured animated
viewmodel with `depthHack` 1/z×3 + `backlerp` interpolation, soldier
alias frame 4, sprite, tracer beam, 12-spark particle cloud, muzzle +
explosion dlights).

Transforms: Quake coordinates (`+X` fwd, `+Y` left, `+Z` up), degrees,
`[pitch, yaw, roll]` pitch-positive-down; gun eye-anchored with the
CPU's depth-hack scale; near clipping preserves the CPU's invariant
(tested by `rgbAliasDepth`).

Effect order (authoritative): opaque world → sky/skybox → deferred
translucent/alpha (back-to-front, exactly-once) → alias/entities →
sprites/particles/beams → dynamic-light contribution baked in surface
cache blocks → resolve (RGB565 quantize + ordered dither) → scanout
reconstruction → display gamma → HUD on top (strict post-scanout in
the CPU reference; the GPU prototype keeps HUD last and documents any
deviation). Transparent ordering is load-bearing: batching must never
reorder blends.

Cvar behavior: all 15 `vd_*` + `sw_*` cvars in §2 apply; the GPU
backend honors `vd_16bit / vd_dither / vd_postfilter / vd_bilinear /
vd_mipdither / vd_lodbias / vd_fog / vd_gamma / vd_maxtexsize /
vd_zbits / vd_palettetex / vd_overbright / vd_dithermode /
vd_reconmode / vd_rgbmaxdelta` with the same semantics as the CPU
voodoo path. Any GPU-specific interpretation is documented in the
GPU-PROOF-4 report, not silently redefined.

Raster tolerances (predeclared review gates, `GPU_PROOF_TOLERANCES`):
`maxFractionDiff 0.02` at `perChannelLsb 3`, `edgeExcludePx 1`,
`maxAbsDeltaWarn 24`. Rationale: 1px border exclusion absorbs
raster-edge/depth-tie differences; 3 LSB absorbs RGB565 quantization +
Bayer-phase noise; anything above 2% or a single-channel spike >24
fails the gate and requires root-cause analysis — never a threshold
loosening. CPU-to-CPU parity is NOT judged by these: same-renderer
re-renders must be `fnvColorFull`-exact.

## 4. Voodoo appearance policy (what the GPU must implement in PROOF-4)

- RGB565 quantization at target writes, 4×4 Bayer ordered dither
  (±4 R/B, ±2 G phase-locked to absolute pixel position), matched
  `2x2sub+2x2box` reconstruction, display-stage gamma 1.3 after
  reconstruction (RAMDAC placement), HUD after gamma.
- Bilinear 4-tap filtering, mip LOD with dithering
  (`vd_mipdither`), LOD bias added to `log2(rho)` (pinned `-0.35`
  for the proof baseline), UVs scaled into the picked level
  (`1/(1<<lvl)` — the VOODOO-REPAIR-2 green-where-red fix is part of
  the contract), 256×256 cap, 16-bit depth at test/write, 64-entry
  table fog (scene contribution zero in `base1` — no haze expected),
  overbright modulate ×2 + clamp.
- Final-frame quantization note (load-bearing): the CPU reference
  quantizes opaque writes to RGB565 **per draw** but composites
  translucent/alpha/additive blends over the stored quantum, then
  reconstructs once at scanout. Final-frame quantization of the
  presented RGBA does NOT reproduce RGB565 rounding *between*
  translucent draws. The GPU prototype's chosen approximation:
  render lit HDR-ish linear values in the render target, apply
  ordered dither + RGB565 quantize at resolve, blend translucents in
  the quantized target in draw order, reconstruct once at scanout —
  i.e. mirror the CPU's per-draw quantize + single reconstruction.
  Test scenes pinning this: combat frames F1/F2 (tracer beam over
  world + sprite + particle cloud + gun fringe). Any deviation is
  reported as an approximation difference, not called bit-exact.
- No claim of hardware-accurate Voodoo3 emulation without a real
  Voodoo3 capture oracle (M4.1 review still pending; `sidebyside.ts`
  slots stay `reference: missing` until a capture lands).

## 5. CPU reference captures + metrics (recorded before GPU results)

Harness: `gpu-proof.test.ts` (Q2_PAK-gated, serial, pinned cvars,
voodoo-resolve display leg); slots `packages/testkit/gpu-proof-ref/`
written only with `GPU_PROOF_WRITE_REF=1` (never overwrite by
default); meta sidecars carry width/height/label/workload/rep/yaw,
display leg, fidelity snapshot, `colorHash` + `displayHash`.

Fixed-frame reference hashes (serial, pinned profile, voodoo-resolve):

| frame | color (raster) | display (scanout) |
|---|---|---|
| F0 stationary | `7165d8b0` | `143ed260` |
| F1 combat | `a18f1963` | `51da7b04` |
| F2 moving (+6°) | `caa6fbd7` | `ef51a709` |

Transparent inventory (per combat frame, `testForegroundStats` +
stage counters): beam 1, sprite 1, particles 13 (1 batch + 12 spark),
alpha 8, `translucentSpans 0`, display `voodoo-resolve` — non-zero on
F1/F2. Combat-vs-stationary full-frame diff 66.3%, moving-vs-stationary
69.0% (different-scene deltas, expected ≫ gate; the 0.02 gate applies
only to future GPU-vs-CPU **same-frame** comparison with mandatory
human review of gun, silhouettes, seams, fog, transparency).

Metrics: `compareGpuProofFrames` (1px edge exclusion, LSB forgiveness,
fraction + maxΔ + PASS/FAIL + `formatGpuProofReport`); CPU-to-CPU gait
is `fnvColorFull` equality (test: re-render hashes match exactly).
Voodoo-vs-real-capture oracle unchanged (`sidebyside.ts` 0.5%/1LSB,
reference missing → review pending).

## 6. Performance acceptance (fixed before optimization)

Gate constant: `GPU_PROOF_GATE` (`tools/bench/src/gpu-proof.ts`) —
median complete-frame work ≤16 ms, completed-frame cadence ≥59 FPS on
a nominal 60 Hz display, p95 frame interval ≤20 ms, all at 640×480
internal, normal fidelity (§2), same scene/route, **hardware-backed
browser**. Record refreshHz, vsync, droppedFrames, compositor detail
(GL_RENDERER), worker count, renderer selection; CPU fallback during a
GPU leg **voids** the leg (`cpuFallback must be false`,
`validateGpuProofBrowserRecord` rejects swiftshader/software/unknown,
wrong resolution, missing refresh/vsync info).

Supplement-vs-gate rule: Node legs supplement but NEVER satisfy the
gate. Node frameMs is production-frame-no-present on the caller clock;
browser presented-FPS is a compositor metric — never mixed. Current
Node CPU baseline (loaded-box supplement, `node-accept-8608859-…05-17-32`,
warmup 3 / reps 5 / workers [0,7], parity PASS, budgets FAIL by design
pre-GPU): sw-fixed-serial 31.49 ms, rgb-fixed-serial 175.14 ms,
rgb-combat-pooled-7 66.95 ms (above quiet-box history 20.48/123.59/
50.35 — loaded box + reduced reps; quiet-box re-run recommended before
freezing contract numbers). Browser legs to date are SwiftShader-only
(14–21 fps presented) and supplement the same way — hardware-backed
access is the prerequisite for GPU-PROOF-5 acceptance.

## 7. What GPU-PROOF-1 leaves for later cards

- PROOF-2: interface-first scene/backend boundary + resource lifetime
  (frozen-contract change needs a `major` changeset + §5 update).
- PROOF-3: real-scene WebGL2 rendering + browser integration tests.
- PROOF-4: appearance implementation + ramp/dither/fog/mip fixtures +
  side-by-side review (human sign-off stays pending if needed).
- PROOF-5: ≥5-minute hardware-backed soak (stationary + movement +
  combat), gate verdict, go/no-go report. At most TWO measured
  optimization iterations after the first complete PROOF-5 run.
