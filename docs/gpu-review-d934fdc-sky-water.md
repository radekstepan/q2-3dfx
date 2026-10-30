# Sky and water review at d934fdc — 2026-10-29

## Result and scope

User reports black borders of the skybox, black exterior sky through windows,
and visible water tile seams despite satisfactory flowing motion. Working tree
was clean at review start. This review changes documentation only. Active tasks
are in BRAIN.md; this file stores findings/evidence, not a second task queue.

## What landed

`d934fdc` connects retained map sky to GPU cold boot, renderer switching and
context restore, using per-face dimensions. It adds explicit clear/replacement
behavior and warnings. The previous diagnosis “no production registerSkyStrip
call” is obsolete. Preserve this integration and the earlier sampler/lifecycle
fixes in `dfc58d9`.

The latest commit does not change the water warp shader, skybox geometry builder
or world UV builder. It does not close water seam repair. User feedback establishes
that water motion is acceptable; avoid redesigning it without demonstrated need.

## Findings

### Sky-face filtering is not isolated

`renderer.ts: skyStripFor` uploads six faces as a single vertical texture with
CLAMP_TO_EDGE and no gutters. `entities.ts: emitSkyBoxFaces` normalizes the CPU
`skyUvOnFace` outputs. That helper bounds local coordinates to 0 through
`tileSize - 1/256`, not GPU texel centers 0.5 through `tileSize - 0.5`.
At internal strip boundaries, bilinear sampling can therefore include the next
or previous face. Whole-strip CLAMP does not prevent this. The shader uses
mediump UVs, another item to evaluate near narrow boundaries on actual devices.
This is a concrete filtering isolation problem; its contribution to the user's
particular black border still needs pixel reproduction. Check source-art dark
regions and orientation separately rather than recoloring them indiscriminately.

Do not assume far-plane clipping: the box half-size is 16384 and GPU far plane
32768, greater than its ~28378 corner radius. Capture evidence before changing
projection/depth policy. The sky also uses the shared flat fog/sampling path;
check it if edge-isolation alone does not explain the observed border.

### Window background depends on selected sky surfaces

`renderer.ts: drawScene` only obtains/draws the sky texture if the current selected
scene contains a world sky reference. Selection is PVS/frustum filtered in
`scene.ts`. With zero sky references, no textured background is drawn even if a
sky asset is retained. This is a concrete conditional to investigate at the
reported window, not proof that it caused that particular black region. Inspect
glass blending/depth and selection at the failing camera. Preserve legitimate
opaque occlusion; globally disabling visibility/depth is not a repair.

### Tests prove wiring, not rendered sky

`apps/web/src/gpu-sky.test.ts` uses a stub document/GL. It checks asset diversity,
backend dimensions, sky references and draw-call logs. The negative control
clears backend registration and detects missing bookkeeping/draws. No real sky
pixels are rendered or compared; counting opaque references does not prove
occlusion. In particular the comment “sky-image check” and claims of a nonblack
page overstate what this test observes. `packages/testkit/src/gpu-sky.ts` validators
likewise inspect assets/state/logs. Keep these useful integration checks but add
actual pixel coverage of borders and windows before visual sign-off.

### Water remains an open spatial-continuity defect

Do not assert a shader diagnosis from the feedback alone. Separate texture-repeat
seams from BSP-face/lightmap boundaries and warp phase/UV scale/LOD/precision
issues at an identified camera and time. Use original-versus-uploaded dimensions,
negative/multi-tile UVs and shared-world-position samples where relevant. Existing
formula mirrors cannot reject the visible seam. Preserve animation, lighting,
transparency and mip behavior while fixing the demonstrated cause.

## Validation and existing suite blockers

Rerun in this review:

- Asset-backed web `gpu-sky.test.ts`: 4/4 passed with local Q2_PAK. These use stub GL.
- Testkit `gpu-sky.test.ts`: 4/4 passed. These are pure validators.
- No actual browser capture or full `yarn verify` was run in this review.

Previous implementation notes report full verify failures: PROOF-4 far/mip metric
0/0 (already assigned to FOLLOW-5) and PROOF-3 CDP evaluation timeout under suite
load (passing in isolation). These claims were not independently rerun here.
Both are now explicit FOLLOW-5 work, so they cannot vanish into a completed sky
card or circularly block all visual repair. Final integrated verify remains
mandatory; intermediate targeted passes are not a full-suite PASS.

## Superseded FOLLOW-3A card

The implementation notes below are archived verbatim for traceability. Dates and
completion claims are historical agent notes, not fresh review validation.

### GPU-FOLLOW-3A — Replace the solid-blue fallback with the map sky
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit`
depends: GPU-FOLLOW-4
status: in-progress(@opencode)
starting-points: `play.ts: loadSkyStrip/skyNameForMap/setSkyTexture`, `renderer.ts: registerSkyStrip/drawSkyRange`
known-cause: no production `registerSkyStrip` call; `dfc58d9` fixed fallback drawing, not sky texture wiring. Do not revert the valid sampler binding fix.
done-when:
- [ ] Retain the loaded map sky and register it with the GPU on cold boot, CPU→GPU selection and context restore. Replace/clear it on map change; avoid rereading or uploading each frame. Pass per-face height, not the six-face strip's total height. Make missing/invalid sky assets diagnosable.
- [ ] Add a negative control that deliberately omits sky registration and fails the sky-image check even though the page stays nonblack and colorful. Use a known textured region of the actual map sky (not an arbitrary patch that may naturally be uniform), with expected asset features/pixels. Add production integration coverage that fails when sky replay is omitted. Capture a real sky-facing map view before/after switching and restoration; prove textured sky pixels, correct face orientation/seams and opaque world occlusion. Do not accept flat fallback, merely nonblack frames, or a direct renderer fixture as completion.
- [ ] Run relevant gates plus `yarn verify`; add changesets and commit the isolated repair with evidence.
- TODO(GPU-FOLLOW-3A) 2026-10-30: repair implemented, relevant gates green
  (testkit `gpu-sky` 4/4; web `gpu-sky` 4/4 incl. Q2_PAK cold-boot/switch/restore,
  negative control, devroom clear; webgl `follow4` 7/7; web `play`+`gpu-hotswap`
  44/44; web `gpu-lifecycle` 16/16; typecheck/lint green; `deps:check` ok).
  Full `yarn verify` NOT green: 2 failures in `packages/testkit/src/gpu-browser.test.ts`
  proven pre-existing/environmental — (1) PROOF-4 appearance far/mip reads 0/0,
  reproduced on the clean stash (owns: FOLLOW-5); (2) PROOF-3 CDP
  `Runtime.evaluate after 30000ms` under full-suite load, passes in isolation
  both with and without this change (30s each). Boxes 1–2 evidenced; box 3
  pending a green full verify.

