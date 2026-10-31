# GPU-FOLLOW-6 gate record — visible-display verification (2026-10-31)

> Lane scope: `apps/web`, `tools/bench`, `packages/testkit`, `docs` ONLY.
> No other `packages/*` or `tools/*` file was modified by this lane.
> Bench is changeset-ignored; docs need no changeset. DO NOT COMMIT
> (integrator merges).
>
> Starting tree: `e214dd4` (clean) — FOLLOW-5 testkit lane merged.
> Box: Ryzen 5 PRO 2400G ×8, Node 22.23.4, Q2_PAK 183997730 B,
> Chromium 156.0.8078.47, X.Org :0.0 + AMD Radeon Vega 11
> (radeonsi, Mesa 25.2.8, DRI direct rendering yes).

## VERDICT: BLOCKED (no visible display — no vsync/scanout)

The card's done-when requires a **hardware-backed visible-browser** soak with
recorded **device, refresh/vsync** and **completed/display cadence** evidence.
That prerequisite is absent on this box:

- `xrandr --listmonitors` → **0 monitors**. All four DRM outputs report
  `disconnected` (`card1-HDMI-A-1`, `card1-DP-1/2/3` → `status: disconnected`).
- The X screen is a virtual 2560×1440 framebuffer (96 dpi, no EDID, no mode
  lines); there is **no connected output, no video mode, no refresh rate and
  no vsync signal** to lock to or to measure.
- Chromium therefore has **no scanout path**: `Page.captureScreenshot` and
  `framesSubmitted` prove on-canvas *submission*, never *presentation*.
  Per the FOLLOW-1 vocabulary (repeated verbatim in the harness output),
  submitted frames / headless throughput are NOT scanout proof, and
  displayed-frame claims on this box are VOID.

Exact missing prerequisite for the integrator:

```
DISPLAY_ABSENT: no hardware-backed visible browser (no vsync/scanout —
X :0.0 has 0 connected monitors, all DRM outputs disconnected; headed
Chromium renders on real AMD Vega 11 GL but presents to a virtual screen
with no refresh signal, so completed/display cadence is unmeasurable).
```

What IS present (so the block is precisely scoped): real GPU hardware with
working direct rendering — `glxinfo: AMD Radeon Vega 11 Graphics (radeonsi,
raven, ACO, DRM 3.64)`, and headed Chromium reports
`ANGLE (AMD, AMD Radeon Vega 11 Graphics (radeonsi raven ACO), OpenGL ES 3.2)`
— i.e. this is NOT the card-assumed "SwiftShader headless only" environment.
The GPU leg below runs on **hardware GL with zero software fallback**
(`actual=webgl2-experimental`, `warning=null`), but without a display it
still cannot produce scanout evidence, so the gate stays BLOCKED.

No thresholds loosened, no goldens replaced, no contract change (FOLLOW-5
tone-normalized proposal still NOT approved, still pending user decision).

## 1. Headed hardware-GL route run (independent work, scanout VOID)

Harness: `tools/bench/gpu-route.mjs` (unmodified) with `GPU_ROUTE_HEADLESS=0`
(headed on `:0.0`), `GPU_ROUTE_WARMUP_S=5`, `GPU_ROUTE_SEGMENT_S=10`,
`GPU_ROUTE_LEGS=webgl2-experimental`, pinned `vd_*` fidelity profile.
(Timings below are submission-cadence/work-headroom evidence only —
rAF cadence = BeginFrames rate, caller-clock splits = CPU submission work,
async GPU duration unknown, `framesSubmitted` = on-canvas submission proof.)

- Log: `tools/bench/evidence/raw/gpu-route-2026-10-31T00-39-53.log`
  (+ `gpu-route-2026-10-31T00-39-53-webgl2-experimental.{json,report.txt}`,
  per-segment `gpu-route-*-{stationary,moving,combat}.png`).
- Boot: `actual=webgl2-experimental warning=null`
  `gl=ANGLE (AMD, AMD Radeon Vega 11 Graphics (radeonsi raven ACO), OpenGL ES 3.2)`
  — hardware-backed, **no silent fallback** (software leg not run; CPU
  fallback field null-by-leg-type, warning path clean).
- Input verification (CDP key events only): movement echo `forward=true`;
  attack method `locked-mouse` (key-Mouse0 candidate did not set
  BUTTON_ATTACK on this build; pointer-lock + CDP mouse press did).
- Warmup: frames 387 → 577 over 5.0 s (≈38 fps submission cadence on the
  occluded headed window — headroom evidence only, NOT a display claim).
- Per-segment (640×480, pinned `vd_*` profile; rAF-submission cadence,
  NOT scanout):

  | segment | dur | frames | cadence | p50 | p95 | p99 | dropped* | cells | yawSpan | submitΔ | uploads | shot |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | stationary | 10.0 s | 577→960 | 38.23 fps | 26.06 ms | 29.36 ms | 42.45 ms | 5 | 1 | 0.0° | 383 | 1 | ok |
  | moving | 10.0 s | 982→1364 | 38.17 fps | 25.93 ms | 29.92 ms | 50.02 ms | 7 | 3 | 139.9° | 383 | 1 | ok |
  | combat | 10.0 s | 1384→1765 | 38.07 fps | 26.02 ms | 29.81 ms | 50.10 ms | 9 | 4 | 1262.8° | 382 | 1 | ok |

  \*dropped = rAF-gap beats ≥34 ms, NOT compositor drops.
- Route summary: 31.9 s wall, 37.26 completed fps; worst-seg p50 26.06 ms /
  p95 29.92 ms / p99 50.10 ms; dropped 21; distinct cells 5; yaw span 1533°;
  `framesSubmitted` advanced by 1148 (on-canvas GL submissions, submission
  proof ONLY); uploads stayed 1 (no re-upload churn → bounded resources).
  Camera path: stationary `pos -285.6 -80.1 -24.0` → moving
  `pos -45.2 118.6 40.0` → combat `pos 190.9 -3.4 24.0` (multi-room/PVS
  movement verified by cell transitions 1→3→4).
- Captures: all three segment screenshots present; combat shot inspected —
  real blaster viewmodel (depthHack), red sky through ceiling opening, base1
  interior, HUD (health/ammo/fps overlay). Compositor readback of a live
  hardware-GL canvas, NOT scanout.
- Harness acceptance (FOLLOW-1 separated verdicts, tolerances fixed):
  coverage PASS (submitted 0→382, workloads all three); fidelity unmeasured
  (route mode computes no fractionDiff — a missing number never passes);
  displayed-frame VOID; overall NOT ACCEPTED. Manifest:
  `tools/bench/evidence/browser-soak-e214dd4-2026-10-31T00-40-46.manifest.json`.
- NOTE on the ~38 fps / ~26 ms medians: the headed window is occluded on a
  virtual screen (no compositor driving it at refresh); this cadence reflects
  occluded-window BeginFrames pacing, not GPU work limits (cf. FOLLOW-2C
  unthrottled headless headroom on the same GPU class) and NOT display
  performance. No perf verdict is drawn from it — the perf gate needs a
  vsync-locked display, so the card's single optimization iteration is
  deliberately NOT spent here (budget preserved for the display-backed rerun).

## 2. Startup: cached-pak-to-first-frame (report-only, separate from steady state)

Measured from the same headed run's log timestamps (runner poll granularity
±2 s — the boot poll runs every 2 s, so this is an upper-bound proxy, not a
first-vsync measurement):

- `leg navigating` 00:39:55.852Z → `booted` 00:39:58.906Z ≈ **3.05 s**
  wall (184 MB pak fetch over loopback + ingest + `bootPlay` base1 at
  640×480 + production loop start; `booted=true` is set after the first
  `startPlayLoop` install).
- Against the existing **≤2.5 s** startup requirement: the measured
  navigation→booted span **exceeds 2.5 s on this harness path**. The page
  re-fetches the full 184 MB pak over loopback on every boot (no browser
  cache, `cache-control: no-store`), so this number is dominated by
  fetch+ingest, not renderer init; a true cached-pak (warm fetch) vs cold
  comparison was not instrumented in this lane. Reported separately from
  steady-state cadence per the card; no startup optimization attempted
  (the card's one-iteration budget is preserved for the integrator's
  display-backed rerun).

## 3. Gate checklist (all BLOCKED on the display prerequisite)

- [ ] ≥5 min hardware-backed visible-browser 640×480 soak (stationary /
  multi-room movement / doors+lifts / combat, viewmodel + effects + sky/water;
  route state, visible captures, bounded resources, no silent fallback):
  **BLOCKED** — headed hardware-GL route smoke (3×10 s) run instead; full
  5-min soak deferred to a display-backed box. No fallback observed in the
  smoke (`warning=null`), route/captures/resources recorded in raw evidence.
- [ ] Immutable build + device + refresh/vsync + raw samples + p50/p95/p99 +
  dropped frames; median work ≤16 ms, ≥59 FPS @60 Hz, p95 interval ≤20 ms:
  **BLOCKED** — build/device/samples recorded, but refresh/vsync are
  unmeasurable (0 monitors) and submitted-frame cadence ≠ scanout proof.
- [ ] Cached-pak-to-first-frame ≤2.5 s, reported separately: **MEASURED
  (≈3.05 s navigation→booted proxy, exceeds 2.5 s on the loopback-fetch
  harness path)** — needs a display-backed rerun with proper first-frame
  instrumentation before any pass/fail verdict.
- [ ] One measured optimization iteration if a perf gate fails: **NOT USED**
  (no display-backed failure to iterate on; budget preserved).

## 4. Files changed (for the integrator)

- `docs/gpu-follow-6-gate-record.md` (this report) — ONLY file changed.
  No `apps/web`, `tools/bench` or `packages/testkit` production/test file
  was modified; no changeset needed (docs unversioned).
- Uncommitted evidence (gitignored raw dir, for the record only):
  `tools/bench/evidence/raw/gpu-route-2026-10-31T00-39-53*`.
