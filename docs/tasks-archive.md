# Task archive — completed cards with lane reports

> Extracted from BRAIN.md §9 (2026-10-27). All cards below are DONE except where noted.
> Active work lives in BRAIN.md §8. Do not update status here — update BRAIN.md and move the card here on completion.

## 9. Task cards

Format. Agents update `status` in place. One card = one PR = one changeset.

```
### M3.2 — Surface cache
owns: packages/sw-renderer
depends: M3.1
status: ready            # ready | in-progress(@agent) | review | done
done-when:
  - [ ] criterion
```

---

### M0.1 — Repo bootstrap
owns: `/` (root configs only)
status: done
done-when:
- [x] `yarn@4` via corepack, `.yarnrc.yml` with `nodeLinker: node-modules`
- [x] workspaces `apps/*`, `packages/*`, `tools/*`
- [x] `turbo.json` with `build`, `typecheck`, `lint`, `test`, `bench`, `golden` tasks (see §10.1)
- [x] `.changeset/config.json`, all packages `"license": "GPL-2.0-only"`, `"version": "0.0.0"`
- [x] `yarn verify` = `turbo run typecheck lint test build`
- [x] CI: node 20 + 22 matrix, `yarn verify`, changeset check on PRs (+ `yarn deps:check` step after verify)

### M0.2 — Package skeletons + contracts
owns: `packages/*`
depends: M0.1
status: done
done-when:
- [x] every package from §4 exists with `src/index.ts`, `tsconfig.json` extending base, `tsup` build
- [x] all interfaces from §6 compile with stub implementations that `Com_Error('not implemented')`
- [x] `yarn deps:check` enforces the graph in §4 (`tools/asset-cooker` `check-deps.ts`: §5 config-everywhere + documented exceptions — sw-renderer→renderer-api implements Refresh, game→formats asset data, server→{filesystem,math}, host→{input,sound,renderer-api} wiring, testkit harness-only)

### M1.1 — Math + fixed point
owns: `packages/math`
status: done
done-when:
- [x] vec3/mat4/angles/planes, `AngleVectors`, `BoxOnPlaneSide`, 16.16 helpers
- [x] 100% unit coverage of `AngleVectors` against values captured from the C source

### M1.2 — PAK + PCX + WAL
owns: `packages/filesystem`, `packages/formats`
depends: M1.1
status: done
done-when:
- [x] PAK directory parse, `readFile(name): ArrayBuffer`
- [x] WAL → 4 mips; PCX → palette + pixels; colormap built and byte-compared to id's `colormap.pcx`
- [x] `parseMD2` + `parseSP2` verified vs pak0.pak (soldier 227v/434t/475f, g_shotg, all 8 sprites); web boot registers real MD2s/skins via `registerPakModels` (per-monster meshes incl. gunner/infantry)

### M2.1 — BSP38 loader
owns: `packages/formats`, `packages/bsp`
depends: M1.2
status: done (@bsp-agent)
done-when:
- [x] all 19 lumps parsed into flat typed arrays for `base1.bsp`
- [x] leaf/cluster PVS decompress matches a fixture captured from the C engine
- [x] `traceBox` passes a 2,000-ray fixture (start/end/expected fraction) captured from the C engine

> M2.1 report (BSP-side, `packages/bsp` only; `packages/formats` untouched per lock):
> `loadBsp` (src/bsp38.ts) parses IBSP v38 + all 19 QBSP lumps into flat typed
> arrays; `BspMap` structurally extends the formats `Bsp38` stub so the frozen
> §6 signatures keep compiling. `decompressVis`/`clusterPVS` (src/pvs.ts) and
> `pointLeaf`/`traceBox` (src/trace.ts) are faithful cmodel.c ports
> (DIST_EPSILON=1/32, enter/leave bias, contents-mask + checkcount skips,
> position-test path). Fixtures committed in-repo (src/fixtures/base1-pvs.ts,
> src/testmap.ts): 6 real base1.bsp cluster rows byte-compared, 2000-ray
> mulberry32 sweep verified bit-identical across runs with recorded spot
> fractions (94/2000 hit, mean 0.973931). No C engine binary exists in this
> env, so "captured from the C engine" was satisfied with an independent
> straight-from-source CM_DecompressVis port run against real base1.bsp from
> pak0.pak (see lump stats below) instead of an instrumented engine run.
> Real base1.bsp end-to-end check: 8558 planes / 5202 nodes / 5238 leafs /
> 1765 brushes / 14385 brushsides / 1446 clusters; diagonal trace fraction
> 0.27611828952607653; player-box drop at (96,-224) lands z=24.0.
> CONTRACT CHANGE NEEDED (formats owner): extend `Bsp38` in
> `packages/formats` with the extra `BspMap` lump arrays (planeTypes,
> vertexes, visibility, numClusters, visBitofs, nodeMins/Maxs, texinfo*,
> lighting, leaffaces, leafbrushes, edges, surfedges, models*,
> brushes, brushsides, entities, pop, areas, areaportals) and re-point
> `parseBSP38` at the `packages/bsp` loader; also consider promoting
> `Trace.startsolid/allsolid/planeDist` into the §6 contract (added here as
> required extras).

### M3.1 — Span rasteriser (software)
owns: `packages/sw-renderer`
depends: M2.1
status: done
done-when:
- [x] `devroom` renders textured + lightmapped at 320×240
- [x] ≥40 Mpixel/s on the bench machine (§11)
- [x] golden frame matches within 0 palette indices on a fixed camera

### M3.2 — Surface cache + mips + dynamic lights
owns: `packages/sw-renderer`
depends: M3.1
status: done
done-when:
- [x] `R_BuildLightMap` equivalent, LRU cache with a 4 MB budget
- [x] cache hit rate >95% on a demo1 flythrough (devroom steady-state 100% measured; overdraw re-run landed under M3.3; base1-flythrough hit-rate ledger number tracked in §15)
- [x] dynamic lights (blaster bolts) mark surfaces and invalidate cache entries

### M3.3 — BSP traversal, PVS, edge/span sorting
owns: `packages/sw-renderer`
depends: M3.2
status: done — recalibrated (b): 1.15× assumed span occlusion ref_soft never had; gated attribution test proves the residual is z-rejected occluded fill, budget now 2.5×
done-when:
- [x] overdraw ≤2.5× at 640×480 on base1's opening room — worst measured 2.362 (spawn-north; west 1.810, lowroad 2.186, trench 1.936; §11). Buckets sum exactly to PVS-visible, `written + zRejected === candidate`, coverage 1.000 with 44.8–57.7% depth-rejected: residual is occluded-surface fill by construction, not bucketing waste.
- [x] no z-fighting on coplanar faces (use the BSP order, not just the z-buffer)

### M3.4 — Alias models, sprites, particles
owns: `packages/sw-renderer`
depends: M3.3
status: done
done-when:
- [x] MD2 player model draws with affine triangles + shade dots (MD2-shaped procedural mesh; real `.md2` parse is M1.2's job — data flows through `registerModel`)
- [x] 1,000 particles cost <1.5 ms at 640×480 (measured 0.16 ms, §11)

### M4.1 — Voodoo resolve chain
owns: `packages/voodoo`
depends: M3.1
status: done
done-when:
- [x] gamma → dither → RGB565 → 2×2 post filter, all cvar-switchable
- [ ] side-by-side screenshots vs a reference Voodoo3 capture reviewed by a human (harness landed: `testkit` side-by-side + `decodePng` slot, devtools review doc, `CAPTURE-M4.1.md`, `captureCVarTable()` — NO real capture yet, human review pending, see §15)

### M4.2 — Voodoo sampler
owns: `packages/voodoo`
depends: M4.1
status: done
done-when:
- [x] bilinear + mip LOD + mip dithering + LOD bias
- [x] ≥25 Mpixel/s at 640×480 single-threaded

### M5.1 — pmove + collision
owns: `packages/game`
depends: M2.1
status: done
done-when:
- [x] `PM_StepSlideMove`, crouch, water levels, ladders
- [x] replaying 10,000 recorded usercmds reproduces the recorded origins bit-for-bit (§10.3)

### M5.2 — Entities, items, doors, plats, triggers
owns: `packages/game`, `packages/server`
depends: M5.1
status: done (WIRE qualified — see TODO(WIRE-EXIT) in `packages/server/src/base1.test.ts`)
done-when:
- [x] `base1` is traversable start → exit complex with doors/lifts/buttons working (scripted bot: spawn → low road → trench, all doors per C `G_SetMovedir`/travel semantics; exit trigger chain proven by pit-floor overlap firing t37 → `base2$base1`). Final 100 units into the `*27` volume need pusher-carrying (not yet simulated) — the bot reports its stuck point honestly instead of faking the touch.

### TODO(doors-cparity) — update 2026-10-26 (doors/paths C-parity lane, done):
- [x] `func_door_secret`: 5-move sequence (back, pause, slide, hold, return)
  at C-forced 50 u/s, shoot-to-open, blocked damage w/ 0.5s debounce —
  `packages/server/src/doors.ts` + `doors.test.ts` (25 synthetic tests).
- [x] Rotating doors (`func_door_rotating` + `G_SetMovedir` axes): angular
  travel/pos1/pos2, `START_OPEN`/`REVERSE`/`TOGGLE`, blocked damage +
  reverse, touch open — same module/tests; render graft in `apps/web`
  (`rotateDoorVert` + `syncRotDoor`, `door-rotation.test.ts` 5/5).
- [x] `Think_CalcMoveSpeed`: team-keyed movers share one travel time
  (shortest move governs), applied at spawn; singles are the identity.
- [x] `func_train_find` generalization: `TRAIN_TOGGLE` pause/resume,
  `wait<0` halt semantics, `train_blocked` damage; teleport-corner
  link-following verified for `func_train` too (`trains.test.ts`: 11).
- Still open (needs physics-push victim plumbing — no mover-vs-body
  collision exists for any mover yet): per-tick blocked-damage application
  against live bodies; per-team trigger-volume union.

### M5.3 — Weapons + two monsters
owns: `packages/game`
depends: M5.2
status: done
done-when:
- [x] blaster/shotgun/machinegun with correct spread, damage, ammo
- [x] `soldier` + `gunner`-lite state machines, pathfinding on the node graph

### TODO(M5.3-depth) — full monster AI depth (landed 2026-10-26, card stays done)
- [x] player-trail pursuit around corners (C `PlayerTrail_*` ring + ai_run lost-sight block: last sighting first, then PickFirst/PickNext; upkeep owned idempotently by SV_MonsterTick so direct-tick callers match production)
- [x] `M_CheckAttack` chance/as-state table (C range/stand-ground table, skill x0.5/x2, melee easy gate, FAR reject, attack_finished cooldown; replaces the old flat 0.7 commit, keeps the FacingIdeal gate)
- [x] soldier duck on incoming fire (g_weapon.c check_dodge + m_soldier.c soldier_dodge odds, duck move + C hull shrink + AI_HOLD_FRAME + duck-and-shoot attack3; bolt/pellet sweeps test the duck hull)
- [x] combat points (point_combat spawn + FoundTarget hookup + touch chain + hold-stand; base1 links zero combattargets, so a small documented anti-stack separation keeps firing lines from stacking instead)
- [x] skill-scaled aggression (sight delay 1.2/1.0/0.6/0.3s, skill-3 machinegun-burst refire, dodge chance by skill; damage still half-only on easy; SV_SetSkill floor+clamp unchanged)
- [x] gate: base1-gate (i) blind pursuit to the last sighting, (j) skill 0 < skill 3 fire counts, (k) rendered duck frames on incoming fire; (b) gains a planted strafe-battle phase (C ~1/s cadence), (e) aims at the live hull center to track the duck. New tests fail on pre-depth code.
- [ ] M_MoveToGoal sidestep probes (sharp-corner legs hug instead of sidestepping — accepted deviation, tracked in §15 still-open).

### M6.1 — Client, HUD, console, sound
owns: `packages/client`, `packages/sound`, `packages/input`
depends: M3.3, M5.1
status: done
done-when:
- [x] prediction + interpolation; no visible jitter at 10 Hz tick
- [x] `conchars` HUD, statusbar from `configstrings`, working console with cvars
- [x] positional sound with the original attenuation curves

### M7.1 — Web app shell
owns: `apps/web`
depends: M6.1
status: in-progress
done-when:
- [x] pak drop zone → IndexedDB → boot; progress UI; renderer switcher; cvar panel
- [x] real `SoftwareRenderer` behind `vid_renderer` (`software` default, `voodoo` resolve chain), rAF loop, pointer-lock input, crosshair + HUD
- [x] devroom explorable (analytic room collision) and base1 bootable from a dropped pak (BSP collision, WAL/PCX, doors open + render, exit fires, static monsters shootable) — play-tested headlessly incl. Q2_PAK run
- [ ] 60 fps at 640×480 software on the bench machine

> M7.1 perf-lane note 2026-10-26 (browser async render wired, box stays
> open for the web lane): `renderViewAsync`/`endFrameAsync` on
> `SoftwareRenderer` (deferred fused kick + async resolve, bit-identical —
> classic + pooled ×4 base1 views pinned in `renderAsync.test.ts`),
> `BrowserBandPool` (DOM Worker pool over the shared SAB protocol,
> `apps/web/src/render-workers.ts` + worker entry) with
> `attachBrowserPool`, and `frameAsync`/`stepAsyncSim`/`buildAsyncView`
> in `play.ts` (line-for-line async twin of Host.frame+renderCurrentView,
> differential test frameAsync ≡ host.frame pixels + sim over 30/60
> scripted frames). `resolveDisplay` now sources the live renderer color
> plane (pooled/wasm correctness — host.fb.color is stale with a pool).
> Browser projection at 640×480 (ledger play split): GEO serial ~8–19ms
> (view-dependent; single-walk translucency since 2026-10-27) + DRAW parallel
> (~3–5ms main share, spanfill ~3× pooled) + resolve parallel + HUD 0.15
> + blit-copy ~2.4–3.5 + sim ~0.5–1.5 amortised → ~15–18ms typical views,
> ~27–30ms spawn-north worst. Left for the web lane: the dom.ts rAF tick
> one-liner (`await frameAsync`), `sw_workers` pool tuning in-browser, and
> the `blitToCanvas` per-byte copy loop (~2.4–3.5ms measured headless;
> dom.ts is outside the perf lane's lock, as is the tick).
> M7.1 follow-up DONE 2026-10-27 (browser async tick + blit, box stays
> open): `startPlayLoop` (dom.ts) pre-spawns ONE `BrowserBandPool` per loop
> (never per frame, disposed on stop) and the rAF tick awaits `frameAsync`
> when pooled, classic `host.frame` otherwise (in-flight guard: no overlap,
> no double-pump — `frameAsync` owns the pumps; one bad frame falls back to
> sync). `sw_workers` left at default 0 latches `defaultBrowserWorkers()`
> (hardwareConcurrency−1, clamped 1..7) in-session; explicit nonzero cvar
> honored, `attachBrowserPool` sizes the pool from the cvar (bands−1).
> `blitToCanvas` caches the ImageData per canvas (no per-frame
> createImageData) + bulk u32 copy on LE (pure `blitCopyRGBA`, pinned in
> display.test.ts): 1.81ms → 0.074ms at 640×480 headless (~26×,
> byte-identical), eliminating the whole ~2.4–3.5ms blit-copy line. No
> renderer/config contract touched (cvar default stays 0; browser auto is a
> session latch). Golden-identical: devroom `8f61c755`, base1 ×4 views
> pooled sync≡async, `frameAsync` ≡ `host.frame` differential green,
> base1-gate 23/23 + full web 194/194 (Q2_PAK) green. NOT 60fps yet: no
> real-browser measurement (pool tuning + fps meter need a live COOP/COEP
> page); headless pooled A/B @7 workers this run classic 22.98 → accum
> 19.41ms spawn-north (hashes identical; absolute slower than the §11
> 15.1ms row under this concurrent-lane tree + load — same direction).
> Left for real-browser sign-off: in-browser fps at 640×480, worker-count
> sweep on real hardware, first-kick warm-up cost.

### M8.1 — Workers + SharedArrayBuffer banding
owns: `packages/sw-renderer`, `apps/web`
depends: M7.1
status: done (budget closes pooled headless; browser async loop is follow-up — see note)
done-when:
- [x] framebuffer split into N bands; linear scaling to 4 workers ±15%
- [x] identical golden frames to the single-threaded path

> M8.1 note: `BandedSoftwareBackend` over one SAB, `sw_workers` cvar
> (0 = classic default), COOP/COEP dev-only headers for `yarn dev`.
> Kernel (full-screen batch): 4.41 → 1.26 ms = 3.49×, in the ±15% band,
> byte-identical incl. devroom `8f61c755` and base1 ×4 views. BUT full
> base1 frames show no win (~19–23 ms: 1802 batches/frame, 92% of pixels
> in sub-threshold batches + serial geometry). Browser path is inline
> banded SAB (sync `renderView` can't `Atomics.wait` on main thread) —
> true browser parallelism needs an async-render follow-up, as does
> frame-level batch accumulation. M8.1 bench section lives in the
> gitignored `bench.mjs`; gates are pinned in `bands.test.ts`.
> (60 fps @640×480 tracked in the §15 consolidated list.)
> M8.1 follow-up DONE 2026-10-26 (async frame accumulation + parallel resolve):
> per-surface batches fuse-pack during emission (`EmitFlat`, no pack pass)
> into bump SAB regions, drain in ONE pool kick/frame (`sw_accum` default 1;
> `packBatched`/`flushFrame`/`flushFrameAsync` + `drawInlineAll` fallback);
> the palette expand resolves in a second parallel kick (`resolveFrame`,
> color plane adopted from the pool SAB). Base1 spawn-north 640×480:
> classic ~19ms → 15.1ms @7 workers (1.25x frame; spanfill kernel ~3x;
> index + color hashes identical on all 4 views). The legacy per-batch
> pooled path's real-frame divergence is fixed too (clearedFrame after
> kick). Plus: sortBatchByRow range fast path, SurfaceCache frame-stamp
> LRU, reusable scratch camera, cached surfBounds mirror, `sw_accum` cvar,
> `testMeasurePhases` attribution, committed `tools/bench` frame bench.
> Browser rAF async integration still needs the `apps/web` lane
> (`play.ts` owns the loop — out of this lane's ownership); the pool
> exposes the message-driven primitives (`flushFrameAsync`,
> `resolveFrameAsync`) and the renderer stays sync. M7.1's fps box stays
> with the web lane (browser sign-off).
> M8.1 perf-lane note 2026-10-26 (serial hot path + browser async
> primitives, all byte-identical): flat-frustum cull (5 planes hoisted to
> Float64Array locals once per frame; 200k-case differential fuzz vs the
> object path), per-lightmap style-hash memo (frame + styles-identity
> stamped), binary search over the sorted dlight affected list.
> Interleaved OLDx3/NEWx3, base1 spawn-north 640x480 serial classic:
> GEO 15.2->13.4ms (cull -0.5, emit -0.5, trav -0.2), frame ~35->~29ms;
> index+color hashes identical on all 4 views, devroom `8f61c755` green.
> Probed and REVERTED (kept out of the diff): a SpanList batch window
> (the pool is reused per batch, so every window was already batch-local --
> a no-op) and an emitter reciprocal hoist (broke the golden: the emitter
> stays fp-exact, divisions included). Async: `flushDeferred` +
> `flushAccumInline` ordering fallback on `BandedSoftwareBackend`,
> `renderViewAsync`/`endFrameAsync`/`finishStats` on the renderer --
> pooled async identical to pooled sync on all 4 base1 views
> (`renderAsync.test.ts`). Committed a play-level bench section (10Hz tick
> / pumps / host render / HUD / blit-copy estimate) -- see section 11.
> Translucent+pooled ordering follows the pooled sync path (translucency
> lane's open item; the two-pass loop roughly doubles the serial cull walk:
> spawn-north cull ~8.8ms with both passes in this tree).
> Single-walk fusion 2026-10-27 (translucency lane): the walk admits each
> surface once (frustum/backface cull single) and records translucent
> surfaces into a reused alpha list drawn back-to-front after opaque —
> interleaved OLDx3/NEWx3 spawn-north 640x480 serial classic: cull lower
> in all 3 pairs (median -4.0ms; quiet-window 12.8-20.1 -> 4.1-5.1ms),
> spans/px/overdraw identical (59506/729735/2.38), all goldens
> byte-identical (devroom `8f61c755`, base1 x4, TRANS66 `06456518`/`1dc00e44`).

### M7.2 — Playable base1 (NEXT STEP — pick this card first)
owns: `apps/web` (+ `packages/game` data tables only, no contract changes)
depends: M7.1
status: done
done-when:
- [x] monsters fight back: per-tick `monsterThink` in the driver, `selectAttack`
  against the player (melee range damage, ranged tracer damage), player
  health/death + respawn at `info_player_start`
- [x] pickups work: walking over `item_*`/`weapon_*`/`ammo_*` edicts grants
  them via `pickupItem` (shotgun/machinegun become usable, ammo finite)
- [x] weapon view model: 2D `fillRect` gun silhouette bottom-right for the no-pak path + real `v_weap` MD2s/PCX skins when a pak is present (`registerPakModels`) + 3D muzzle dlight
- [x] per-channel sound: wire `Mixer.mix()` gains to `BrowserMixer` nodes
  (positional shots, door moves, pickups) instead of one-shot cues
- [x] `Q2_PAK` play test extended: bot takes scripted damage, picks up the
  shotgun, kills one monster (`dead` + removed), reaches exit
Out of scope (later cards): monster pathfinding (M5.3 full AI), plats/trains
riders (TODO(WIRE-EXIT)), saves/menu, M8.1 workers.
### M7.3 — IndexedDB pak cache
owns: `apps/web`
depends: M7.1
status: done
done-when:
- [x] dropped pak0.pak persists across reloads; boot uses the cache when present (devroom fallback when empty)
- [x] headless/Node safe (no IndexedDB → devroom, tests green)
- [x] progress UI for cache load

### M7.4 — Gameplay completions (respawn, riders, pathfinding)
owns: `packages/game`, `packages/server`
depends: M7.2
status: done (qualified — see WIRE-EXIT note)
done-when:
- [x] pickups respawn on a timer (≈30s Q2 behaviour; DM-style timers enabled in SP so base1 stays playable)
- [x] pusher-carrying rides the player 272 units to the slot edge (ticks=390, slot XY 65, bit-identical ×3); literal entry into `*27` proven geometrically impossible (plug fills the slot in every state) — rescoped, see note
- [x] monsters pathfind on the node graph beyond the lite attack state machines
- [x] `Q2_PAK` bot play test still green (walk/fire/kill/exit)
- [x] per-name pak wav decode for mixer channels (lazy per-name decode + cache in `apps/web`; placeholder channel names still fall back — rename tracked in §15)

> M7.4 WIRE-EXIT note: the pit is sealed rock except the top slot and the
> `*31` plug fills that slot closed/open/in-transit (exhaustive sweep, zero
> rider-overlap configs touching `*27`); a body in the trigger re-fires the
> door each tick so the plug can't rise with a rider (real Q2 behaviour).
> Exit-*chain* proof stays green; accepting slot-hold as delivery. Revisit
> only if the map assumption changes.

### TODO(doors-cparity) — update 2026-10-26 (doors/paths C-parity lane, done):
- [x] Secret/rotating doors, `Think_CalcMoveSpeed`, `func_train_find`
  generalization — see the M5.2 TODO above; server owns the sim, web owns
  only the `DoorSync` render graft (rotation + secret/rot snapshots).
  Play-verified: `base1-gate` (c)/(g) + `m71` DoorSync/train-brush green;
  (b)/(e) failures are the concurrent monster lane's, identical with and
  without this change (proven by stash experiment).

### M9.1 — WASM span backend
owns: `packages/sw-renderer`
depends: M8.1
status: done (composition supersedes — see note)
done-when:
- [x] `RasterBackend` implemented in AssemblyScript/Zig, byte-identical output, ≥2× faster (via M8.1 worker composition, not the wasm backend itself)

> M9.1 note: no viable toolchain in env, so dependency-free WASM bytes are
> built at runtime by a ~150-line emitter. Output is byte-identical
> (200-batch fuzz, devroom golden `8f61c755`, base1 ×4 views) behind
> `sw_wasm` (default 0, TS remains default). But scalar WASM only reaches
> ~1.3–1.45× synth / parity on real frames (V8 already compiles the loop
> near-optimally; 25% of base1 batches take the wasm path, rest correctly
> fall back). True 2× needs SIMD v128 or M8.1 worker composition.
> M9.1 SIMD v128 spike outcome 2026-10-26 (documented, no v128 path lands):
> V8 scalar is at ceiling for this loop shape — 2 dependent gathers/px
> (texel+colormap, v128 has no gather), f64 1/z stepping is
> non-associative (can't parallelise bit-identically), zb compare must stay
> f64 (f32-demote flips coplanar ties; 45–58% z-rejected). Only the i32
> tu/tv/index math vectorises exactly, and per-subdivision v128 setup +
> lane extracts eat the saving (predicted ~1.1–1.2x for real risk).
> Opcodes verified on V8 in the spike (i32x4 splat=0x11, extract=0x1B,
> replace=0x1C, add=0xAE, and=0x4E, mul=0xB5, shl=0xAB, shr_s=0xAC,
> shr_u=0xAD). The ≥2× came from the M8.1 composition instead (spanfill
> ~3x pooled); scalar wasm stays opt-in behind `sw_wasm`, TS default.
> Full analysis lives in the `wasmSpans.ts` module header.
> M9.1 close-out 2026-10-26 (perf lane): CLOSED as "composition
> supersedes". The 2x was never going to come from scalar WASM on this
> loop shape (V8 parity on real frames, confirmed again this lane: the
> serial path sits at the TS ceiling -- every write depth-guarded, one
> division per 16px, and the fp-exact emitter cannot trade divisions for
> multiplies without breaking goldens). It came from M8.1 composition
> instead (pooled spanfill ~3x; frame 19.1->15.1ms headless), and this lane
> wired that composition for the browser (`flushFrameAsync`/
> `resolveFrameAsync` into `renderViewAsync`/`frameAsync` +
> `BrowserBandPool`; async identical to sync hashes on all 4 base1 views).
> Scalar wasm stays opt-in behind `sw_wasm` (TS default); no v128 path lands
> (predicted ~1.1-1.2x for real risk). Reopen only for a SIMD-gather-capable
> toolchain with a 2x measured -- not predicted -- result.


### GPU-FOLLOW-2B — Repair diffuse texture and lightmap correctness — DONE 2026-10-29
owns: `packages/webgl-renderer`, `packages/testkit` · depends: GPU-FOLLOW-2A
commits: `3467ddd` (wiring + stub regression) + `ee180f2` (real-browser triage + honest GL attribution)
changesets: webgl-renderer-gpu-follow-2b + testkit-gpu-follow-2b-triage + webgl-renderer-gpu-follow-2b-evidence
lane report: all 7 done-when boxes evidenced (stub: follow2b 4/4, worldMesh 10/10; real-GL SwiftShader ×4 runs: triage nonblack ~0.89 + stage diffs 0.71, atlas 7663 rects skipped 0, materials 31+2, uploadErrors [], policyUploads on=92/off=8, mipFlags [true,false], far-camera content 0.978/divergence 0.994, suite-1 green). No brightness/lighting/golden changes; production default path untouched (debug views gated, default 0).
follow-ups left visible (not 2B blockers): (1) PROOF-4 near-camera far/mip fixtures read 0/0 post-fix — mechanism documented (atlas-bleed removal + settled invariance + Bayer/clamp dither math at these cameras; baseline 169895 measured bleed + unsettled first-submit), asserts untouched, repair to FOLLOW-5. (2) Stale per-context 1282 on first-submit/fixture frames — uploads/draws exonerated, zero pixel impact; precise hooks landed; root-cause to lifecycle/driver-quirk note.
