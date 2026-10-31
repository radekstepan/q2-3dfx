# Review of 2c4c162 — 2026-10-30

Scope: source and commit review against the user's latest retest. No runtime
tests, screenshots or benchmarks were rerun. User-observed failures are current;
possible causes below are not browser-confirmed diagnoses. BRAIN.md owns the queue.

## Findings

1. **P1 — RELEASE-3 completion is unsupported and contradicted by user retest.**
   `apps/web/src/aim-hud.test.ts` computes half-width/height itself, boots only
   software, and ends with `expect(true).toBe(true)`. It never renders a GPU
   crosshair, fires a shot or measures a DOM rectangle. The new `frameGpuPlay`
   backing-size self-heal cannot establish CSS alignment. `dom.ts: startPlayLoop`
   requests twice the framebuffer CSS dimensions; `gpu-canvas.ts` copies those
   requested sizes to an absolutely positioned GL surface while the HUD remains
   in flex flow under max-size/object-fit constraints. Measure rendered content
   bounds and clipping in the real page. Required cases now include 800×600
   WebGL2 aim/weapon/HUD displacement and 1024×768 Software canvas displacement.

2. **P1 — RELEASE-4 and RELEASE-5 were marked done without a gameplay repair.**
   The commit changes no server/game production code or elevator activation path.
   The elevator changeset asserts existing behavior is correct, but supplies no
   new approach/boarding/button regression. User still reports premature departure
   and clipping into infantry. Identify the actual mover/target chain and replay
   the route before declaring original-game parity.
   `release-5-location.test.ts` checks hull/step constants and `48 > stepHeight`;
   it never loads base1, locates the soldier or moves either entity. Thus it cannot
   confirm wall climbing is impossible at (-1148.1, 1542.3, -24). Its fire test
   only checks `INFANTRY_C` exists; it proves neither hitscan execution nor muzzle,
   tracer, impact, timing or sound fidelity. Keep wall movement unverified and
   infantry-fire audit open, rather than asserting either is fixed or broken.

3. **P2 — Water diagnostic does not diagnose rendered seams.**
   `water-seam.test.ts` checks pure warp helpers at a few coordinates. It samples
   no texture, LOD, derivative, lightmap, BSP boundary or rendered pixel. No
   renderer production code changes in this commit. The former TODO's claim
   that diagnostics point to LOD/lightmap seams is unsupported by this artifact.
   Reproduce the seam before choosing a repair; preserve the satisfactory motion.

4. **P2 — Devroom visual acceptance is not evidenced by the added tests.**
   Real world/palette/replay wiring was added, but `devroom-gpu.test.ts` boots
   software and checks palette shape/source labels. Its purported negative control
   merely checks a helper is non-null. It does not render GPU pixels or deliberately
   remove a world. Leave RELEASE-2 in review; latest feedback is not a verdict on
   this implementation. Audit swallowed replay errors during actual lifecycle checks.

5. **P2 — Several requested changes were left as TODOs, not implemented.**
   Asset HUD/F1/intermission remains placeholder-based; `REBOOT_CVARS` still
   includes `vid_resolution`; HTML initializes the canvas at 320×240;
   `vid_renderer` still exposes `voodoo`. RELEASE-6/7/8 remain open.
   Renderer hot-swap already exists: determine why the user's menu flow appears
   to restart, and preserve simulation state while fixing resolution changes.

## Tracking corrections

BRAIN.md had duplicate checked/unchecked lists for RELEASE-2/3 and claimed
RELEASE-3/4/5 done despite missing evidence. Those cards are reopened, duplicates
and redundant TODO sections removed, and stale agent ownership cleared. Volume
and devroom implementation are retained with acceptance pending review. Sky fixes
remain user-confirmed. No claim of a green integrated gate is made here.

The next pass must exercise the actual browser and map scenarios. Passing the
new arithmetic/constant tests again would not resolve these findings. Record
exact build, map/camera, viewport, renderer and before/after evidence per card.
