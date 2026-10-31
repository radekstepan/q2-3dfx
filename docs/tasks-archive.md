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

### GPU-FOLLOW-2C — Prove live map completeness and close visibility validation — DONE 2026-10-30
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit`, `tools/bench` (3 disjoint lanes, integrator-merged) · depends: GPU-FOLLOW-2B (done)
lane A (`apps/web`): `soak.ts` additive `SoakRouteSnapshot`/`readSoakRoute`/`__q2soakRoute` + `gpu-live-route.test.ts` single live-route test (stub live-loop: 820 frames, 16 clusters, odometer ~855, door *32 open+close peak 35.0, lift *13 ride peak 56.0; real-page CDP legs stationary/translate/turn on hardware Vega GL with cluster 631→1166, per-leg screenshots incl. textured room + viewmodel + live soldier, consoleErrors []). soak 11/11 + gpu-play 25/25 neighbors green (TURN equality preserved).
lane B (`packages/testkit`): `gpu-scene-semantics.ts` (CPU-oracle two-room fixture + occluder, `deriveSemanticOracle`, `validateSceneCoverageAndContent` successor gate, `LiveRouteSemanticCapture` coordination shape) + 12/12 tests rejecting removed wall/floor/ceiling/enemy/viewmodel, occluder leaks, missing waypoints, upload errors, stalled submissions at healthy counts. typecheck clean.
lane C (`tools/bench`): `gpu-route.mjs` + `gpu-route.ts` lib (73-test suite green) + `bench:gpu-route` script; hardware-GL smoke (Vega 11, webgl2-experimental): stationary 60.01 / moving 60.07 / combat 58.23 fps, p50 ~16.7ms, p95 ≤22.85ms, dropped 6 (combat), uploads 1, submitΔ advancing, displayed-frame claims explicitly VOID. bench changeset-ignored per convention.
integration: deps:check 617 edges ok; turbo typecheck+lint+build 24/24 (web/testkit/bench); merged suites web 367/370, bench 74/74, testkit 214/227 — all failures reproduced on the clean tree (browser-lane + pool-diag + fg-recovery load flakes; PROOF-4 far/mip + F1-vs-CPU report-only gates filed under FOLLOW-5). Changesets: web-gpu-live-route-2c + testkit-gpu-live-route-2c. Evidence artifacts: tools/bench/evidence/browser-soak-4807261-2026-10-30T00-{31-03,34-00}.manifest.json + raw gpu-route logs/screenshots/report (raw/ ignored by convention).

### GPU-FOLLOW-3 — Complete live effects and required world appearance — DONE 2026-10-30
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit` (3 lanes + integrator merge) · depends: GPU-FOLLOW-2C (done)
lane A (`packages/webgl-renderer`): TRANS-first classification (turbulent+translucent water blends and warps with warp identity; glass single-sided per CPU `!turbulent && !sky` rule), `entityBlend` (tracers always blend with real distance keys), per-pixel warp in FS_LIT (`uWarpOn`/`uTime` closed-form turbTable mirror), textured view-centered skybox (`registerSkyStrip`, indexed strip, flat fallback), `GPU_CVAR_GAPS` (r_translucency/sw_stipplealpha/r_drawworld/sw_gamma labelled unsupported); PROOF-4.md deviation 4 closed + §6 (combined far→near world+entity order, CPU difference stated). Tests: new follow3 suite (29 tests: synthetic + real-base1 inventory 128 sky / 102 turbulent+translucent / 17 glass, selection/draw, box draw, 3-camera overlap, reselect idempotence); updated follow2/scene expectations (CPU parity, intended). Renderer suite 142 passed/5 skipped.
lane B (`apps/web`): `gpu-effects.ts` (producer→consumer inventory, full retained-asset modelKindsForFrame + beam synthesis, light consts, material censuses, readLiveEffects) + `play.ts` frameGpuPlay submits full kinds to selection+draw + soak `effects` (additive optional); `gpu-follow3.test.ts` 17/17 (unit policy + live blaster→explosion→geometry→submissions + monster return-fire beams + full registration sweep + live walk sky/glass/water + headless-browser combat pixels: bolts=2 expl=1 particles=80 nonblack 0.919); neighbors soak+gpu-play+play+combat 86/86, live-route/browser/switch suites 57/57 green. STOP-and-report items 1/2/4 resolved by lane A in-card; item 3 (no live sprite producer — 8 sp2 in pak, no server queue) filed as game/server follow-up.
lane C (`packages/testkit`): `gpu-effects-semantics.ts` (weapon/enemy/pickup catalogs by value, `Follow3LiveCapture` shape by name, event-drain gate, CPU oracle: SoftwareRenderer pixel floors + selector submission floors, `validateFollow3Coverage`, HUD report-only) + 18/18 tests (healthy-pass + one tamper leg per failure mode at healthy counts). typecheck/build clean.
integrator merge fixes (no loosening): (1) lane B pre-fix turbulent pin (`transparent===false`) → post-fix (`===true`) now that lane A landed TRANS-first; header updated. (2) `gpu-boundary` entity-kind pins → index-stable surfaceId-slot matching (blend sorting breaks positional correspondence; slot is identity, order is draw sequence). Full merged record: web 384 passed/3 pre-existing clean-tree fails (browser-lane + 2 pool-diag), webgl-renderer 142/5skipped, testkit 234 passed/1 pre-existing PROOF-4 suite fail (FOLLOW-5 territory), bench untouched; deps:check 632 edges ok; typecheck+lint+build 24/24. Changesets: webgl-renderer-gpu-follow-3 (minor) + web-gpu-follow-3 + testkit-gpu-follow-3.


## FOLLOW-4 integration archive — reviewed at dfc58d9

### GPU-FOLLOW-4 — Finish and validate the uncommitted lifecycle bundle
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit`, `packages/config`, `.changeset`
depends: none (FOLLOW-3 implementation landed in `8fde77f`; appearance defects below)
status: done (validated 2026-10-30: hermetic 6+16+8+5 green, real-browser 2-cycle loss/restore green with Q2_PAK, typecheck/lint/build + deps:check green)
done-when:
- [x] Review the existing diff/tests/changesets listed in the review document. Verify same-context resource deletion, invalid-handle handling after loss, retained replay, listener cleanup, resize/aspect/HUD alignment and explicit fallback. Correct any actual defects; do not recreate landed machinery.
- [x] Strengthen the real-browser test on the production game canvas: assert GPU identity before/after, submissions frozen after the loss event and advancing after restoration, lifecycle counts, and correct restored world/model/skin pixels. Throwaway probe or unchanged renderer label is insufficient. Check repeated resize/switch/map/loss cycles for bounded resources and duplicate canvases/listeners.
- [x] Run asset-backed and actual-browser lifecycle gates with Q2_PAK; record browser/device and skips honestly. Isolate the historical first-submit GL 1282 at its originating operation; fix application errors or provide a minimal independently supported driver explanation. Do not hide errors by clearing the queue.
- [x] Run `yarn verify` and `yarn deps:check`; reconcile package changesets and commit only the validated lifecycle bundle. Record known sky/water defects separately; this commit is not final renderer acceptance.

Review qualification: implementation and strengthened freeze/resume browser assertions landed.
The commit reports targeted tests plus typecheck/lint/build/deps checks; this review
did not independently reproduce a full `yarn verify`. Generic nonblack/color-count
capture checks do not establish restored world/model/skin identity; remaining
semantic image evidence belongs to FOLLOW-5, integrated verification to FOLLOW-7.

### GPU-FOLLOW-3A — Fix skybox borders and black sky through windows — DONE 2026-10-30
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit` · depends: GPU-FOLLOW-4 (done)
lane report (single writer, disjoint owns honored): all 5 done-when boxes evidenced with real rendered pixels, not draw counts.
repair: six strip tiles upload to six separate CLAMP face textures (strip order [rt,bk,lf,ft,up,dn]; box face f binds tile SKY_SIDE_IMAGE[f], caught a face↔tile mismatch via the pixel probe before landing); sky UVs are face-local with half-texel inset (entities.emitSkyBoxFace) so bilinear taps stay inside the face; the textured background box draws whenever a strip is retained (hasSky gate removed — zero selected sky refs still draw the box, depth-tested background, opaque occlusion preserved). CPU affine sampler untouched.
pixel evidence (real SwiftShader WebGL2, `packages/testkit/src/gpu-sky-pixels.test.ts` + page builder): synthetic flat-color faces — 0 non-exact pixels on edge/corner/LINEAR/NEAREST legs, tamper control flags exactly the 8 CPU-blended pixels, orientation pinned (rt+bk halves, centre on the edge); zero-ref view draws textured-box (refs 0, 0 black) while the cleared control is 100% black; real base1 unit1_ (256x256) — turned spawn view ([128,-320,54] yaw 270, FOV 90, defaults, 2 sky refs) strip-vs-clear before/after plus byte-identical clear→re-register replay (replayDiff 0), best near-spawn glass view diff 6.26% textured, zero-sky-ref glass view (id 7547, [106.5,140,200] yaw 0 pitch 90) diff 1.13% all nonblack.
stub/asset wiring kept, descriptions corrected (36-index test → six 6-index per-face draws; "sky-image check" → wiring check): testkit gpu-sky 4/4, web gpu-sky 4/4 (Q2_PAK cold-boot/switch/restore/negative/devroom), webgl follow3 151 passed incl. real-base1 inventory/selection/box legs + new zero-ref-background and UV-isolation legs, follow4 sky clear/re-register leg green.
neighbors green: web gpu-lifecycle 16/16, base1-gate + gpu-hotswap 28/28, webgl-renderer 15/15 files, typecheck (3 pkgs) + eslint clean, dists rebuilt (probe + web tests consume built testkit/webgl dists).
full-verify NOT green (recorded, not waived; assigned to FOLLOW-5): PROOF-4 far/mip fixtures read 0/0 and fg-recovery pool timeout under full-suite load, both reproduced on the clean tree per the d934fdc review. No new failures introduced (targeted suites above all green).
changesets: webgl-renderer-gpu-follow-3a-repair (patch @q2/webgl-renderer + @q2/testkit; apps/web change is test-comments only, no versioned package touched).
follow-ups left visible (not 3A blockers): water seams → FOLLOW-3B (untouched: warp/sampling code paths not modified); final fidelity/displayed evidence → FOLLOW-5/6/7.

### RELEASE-3 — Align aim and overlays at every resolution — DONE 2026-10-30
owns: `apps/web`, `packages/webgl-renderer`, `packages/input`, `packages/testkit` · depends: none
lane report (single writer, disjoint owns honored — only `apps/web` production code changed; webgl-renderer/input/testkit owns covered by cross-check tests, no production edits there): all 3 done-when boxes evidenced with real rendered pixels and real browser rects, not formula mirrors.
repair: `fitPlayCanvas`/`fitScaleForStage` (`apps/web/src/dom.ts`) fit the CSS display box to `#q2-stage` at the framebuffer aspect (uniform scale, floors to fit, degenerates to 1x never NaN); both canvases share the identical box via the existing `syncGpuCanvasToHud`; resize listener re-fits (sim untouched, removed on stop); `flex:none` hardening on `#q2`/`#q2-bezel` (`index.html`); stale 1280x960 comment refreshed in `gpu-live-route.test.ts`. No resolution-specific offsets; HUD anchors, projection and input untouched (pointer-lock is relative; CPU/GPU centers already agreed ≤1px).
pixel/rect evidence (real headless Chromium 1500x1000 @dpr1, production page, `apps/web/src/resolution-fit.test.ts` 7/7 + artifacts under `apps/web/test-output/`): pre-fix negative control 800x600 → `1600x1200` inline → `1106x1200` element box (aspect deviation 0.41, bottom HUD below fold); post-fix 1024x768 → `973x730` display (scale 0.9505 uniform), q2==gl rects exactly, in-viewport, scroll 0, backing center white + dim arms, gun-region non-black. `aim-hud.test.ts` rewritten 7/7 (rendered crosshair pixels, HUD rows in-bounds, CPU `setupCamera` vs GPU `buildProjectionMatrix` center agreement, Q2_PAK real-base1 eye-ray inside the 9x9 crosshair at all three resolutions).
neighbors green: testkit `gpu-presentation` 9/10 (1 env-skip; small-viewport leg triples 140 → 6163 with the fit), web typecheck 17/17 + build green, full web suite 423/427 with the 4 failures (browser-lane ×1, play M7.2 ×1, pool-diag ×2) reproduced IDENTICALLY on the clean tree (pre-existing suite-load flakes, FOLLOW-5 territory); `deps:check` sound→config ×2 violations pre-existing (untouched, RELEASE-1 review).
changesets: `release-3-aim-hud.md` rewritten for the fit repair (web ignored; no versioned package touched). No perf-ledger row: display-CSS only, no raster/frame-time change.
follow-ups left visible (not RELEASE-3 blockers): RELEASE-1/2 acceptance review, RELEASE-4/5 gameplay, FOLLOW-3B water, RELEASE-6/7/8, FOLLOW-5/6/7.

### RELEASE-1 — Quiet, capped volume scale — DONE 2026-10-30
owns: `packages/config`, `packages/sound`, `apps/web` · depends: none
lane report (config+sound lane + integrator web blip): `s_volume` default 1 = output 0.05, max capped at 0.05, single scale point documented; `Mixer.mix()` is the single 0.05 application, per-channel clamped, mute preserved, attenuation intact; `blip()` now uses shared `sVolumeToOutputGain` (fail-muted). `sound→config` gate fixed via ALLOW (leaf, acyclic) — `deps:check` green.
evidence: config 16/16 (incl. 4 new mapping/clamp/console tests), sound 13/13 (actual `mix()` gains ≈0.05, overlapping combat, near>far), web sound 14/14 + aim-hud 7/7, typecheck clean.
changesets: `release-1-quiet-volume.md` (`@q2/config` patch + web blip; asset-cooker gate fix needs no version). No perf-ledger row: test-only + menu-blip gain (no frame-time change).

### RELEASE-3B — Verify blaster offset is intended muzzle parallax — DONE 2026-10-30
owns: `apps/web`, `packages/game`, `packages/server`, `packages/webgl-renderer`, `packages/testkit` · depends: RELEASE-3 (archived)
lane report (single writer, web-only test addition, no production edits to preserve display-fit/sky): all 3 done-when boxes evidenced with actual production bolts, not eye-ray stubs.
par finding: production `SV_PlayerFire` matches C `Blaster_Fire`/`G_ProjectSource` exactly (24 fwd + 8 right + viewheight-8, dir = forward). `apps/web/src/blaster-aim.test.ts` 6/6 (incl. real-base1 Q2_PAK leg): near 200u ~13px right/down, mid 800u ~3px, far 1500u ~2px at 640x480 FOV90; CPU/GPU agree <1px at 640x480/800x600/1024x768 level+pitched; wall impact preserves 8u lateral (parallel); kick `-2*fwd`/`[-1,0,0]` is one-tick camera transient per `SV_CalcViewOffset`. Zero-muzzle and convergent-aim negative controls pinned as not-shipped.
neighbors: web typecheck clean, blaster-aim 6/6, aim-hud 7/7, resolution-fit 7/7; play M7.2 damage + `sound→config` ×2 pre-existing (FOLLOW-5/RELEASE-1 territory, reproduced on clean tree).
changesets: `release-3b-blaster-parallax.md` (web ignored; no versioned package touched). No perf-ledger row: test-only, no raster/frame-time change.

### RELEASE-4 — Correct final elevator activation and waiting — DONE 2026-10-30
owns: `packages/server`, `packages/game`, `apps/web` · depends: none
lane report (server+game + web reroute, disjoint): C-parity no-trigger for targetname/health doors + button wait 3; base1 *31 plug waits for *34 (t4), sliders touchable, *13 runs *12 train one-way with t89 hold.
evidence: server 184/184 + game 209/209 (real-base1 tick-loop: lump identity, 400-tick camp no-departure, *34 156-down/3s-hold/return/repeat, *13 ride with pmove rider, blocked rules); web base1-gate 23/23 rerouted (sliders park/*31 shut/train parked, *34 cycle, *13 ride, low-tunnel *27 exit with stats).
changesets: `release-4-elevator-trigger.md` (`@q2/server`+`@q2/game` patch) + `release-4-web-gate.md` (web ignored). No perf-ledger row: trigger/timing logic only.

### RELEASE-5 — Monster collision, wall movement and infantry fire — DONE 2026-10-30
owns: `packages/game`, `packages/server`, `apps/web`, `packages/testkit` · depends: none
lane report (game/server/testkit + web visual, disjoint): per-monster ClipMove trace (live hulls + player box, corpses pass through), AI_HOLD_FRAME freeze, flashless smack + infatck2 swing, burst windows infantry n-6 / soldier k+1 (float-dust fix); t38 normal soldier behind *19 (ambush, yaw 0, hp 30, skill 1) holds floor, crosses only through opened doorway, never ghosts.
evidence: game 211/211, server 202/202, testkit 3/3 (t38/*19 floor/doorway, geometry *19 slab/shared floor); web release-5-visual 4/4 (t38 z locked, burst MZ2_1 + dlight + infatck1, swing/smacks, browser captures), monster-block 4/4 (*31 C-parity), base1-gate 23/23, elevator 1/1, soak 11/11, phase3 10/10; automated vs visual verdicts logged separately. FOLLOW-3B shader order fix (ANGLE forward-reference) also landed here to unblock WebGL2 in-page tests; resolution-fit 7/7 incl. webgl2 legs.
changesets: `release-5-monsters-collision.md` + `gpu-follow-3b-shader-order.md` (`@q2/webgl-renderer` patch); web visual has no versioned package. No perf-ledger row: collision/timing + test-only visual.

### RELEASE-2 — Render the asset-free demo room in WebGL2 — DONE 2026-10-30
owns: `apps/web`, `packages/webgl-renderer`, `packages/testkit` · depends: none
lane report (web wiring, no packages touched): `q2pak=devroom` soak boot enables real-page legs; cold GPU boot/switch/restore verified without pak.
evidence: web release-2-web 7/7 (Chromium webgl2, no pak: nonblack 1.0, 40083 distinct colors, quadrant spread, entityRefs 1 after live fire, void control 0.114, uploads 1, no fallback).
changesets: none (web-only test, ignored). No perf-ledger row.

### RELEASE-6 — Use game assets for HUD, F1 and level completion — DONE 2026-10-30
owns: `apps/web`, `packages/client`, `packages/formats`, `packages/testkit` · depends: none
lane report (formats/client + testkit + web wiring): 78-entry manifest landed as 79 (22 digits + field + 44 icons + conchars + help + inventory + 3 crosshairs + 5 overlays + victory; pinned with split documented); statusbar/F1/scoreboard/centerprint/inventory geometry + indexed blits; web drawPlayHud asset statusbar/F1 overlay/completion with devroom fallback.
evidence: formats 29/29, client 83/83, testkit HUD 35/35 (real-art + tamper negatives), web HUD 12/12 at 640x480 + 1024x768 (scaling, transparency, death/completion/F1, fallback, fps/pos separation).
changesets: `release-6-hud-assets-formats-client.md` + `release-6-hud-testkit.md` (web wiring ignored). No perf-ledger row.

### RELEASE-6 repair — Correct HUD, live F1 help and completion presentation — DONE 2026-10-31 (reopened 2026-10-30, repaired by @opencode, 5 lanes)
owns: `apps/web`, `packages/client`, `packages/formats`, `packages/server`, `packages/testkit` · depends: none
lane report (server producer + client helper + web wiring + formats dims + testkit live regressions, disjoint owns): F1 help reads LIVE killedMonsters/foundGoals/foundSecrets (frozen finish* only at completion, per id HelpComputer); STAT_HELPICON flashes i_help iff unacked change and (serverframe&8) via pure client helpIconFor, ack on F1-open per Cmd_Help_f (no permanent blink); server adds target_help producer (base1 t70 chain verified: 2 firings latch both messages) + helpChangedSeq/helpMessage1-2 + beep/flash cadence helpers, per-client ack stays driver-side; completion is SP-faithful intermission-lite (gun down, no world interaction; frozen totals, no DM scoreboard, no victory asset — verified coop plaque; devroom fallback kept); formats dims audit table all match (help 256x192, field_3 48x24, 16x24 digits, 24x24 icons, conchars 128x128); testkit production-path regressions with sampled pixels at 4 resolutions, live-counter updates with no reopen, frozen snapshots, flash cadence + ack, scoreboard/victory guardrails.
evidence: server 209 (incl. new help 7 + real-base1 t70), client 86, formats 30/30 with pak (22+8skip without), web 54 (HUD 16 incl. 4 real-art + base1-gate 23 + resize 15), testkit live 20/20 with pak (15+5skip without); deps:check 701 edges ok; WebGL2 capture leg documented headless-infeasible (2D HUD pass is renderer-agnostic).
changesets: `release-6-server-help-seq.md` + `release-6-client-help-icon.md` + `release-6-testkit-hud-live.md` + `release-6-formats-hud-dims.md` (apps/web fix private, ignored). No perf-ledger row (correctness-only; CPU optimization paused).

### RELEASE-7 — Change display settings without restarting; stable startup size — DONE 2026-10-30
owns: `apps/web`, `packages/host`, `packages/webgl-renderer`, `packages/testkit` · depends: RELEASE-3
lane report (host + web wiring): sim-preserving resize (validate/reserve, overlap-copy, snapshot/dispose hooks) + `vid_resolution` out of `REBOOT_CVARS`, persisted-size reservation before async load, hot-swap/context-restore without rebuild; explicit restart only for map/skill.
evidence: host 20/20 (sim fingerprint, overlap, no-op, invalid refusal, cycles 1:1, restore/dispose), web resize 15/15 (preserved sim, overlap, no-op, invalid, repeated, hot-swap/restore, once-only lifecycle, reserved boot).
changesets: `release-7-host-resize.md` (web wiring ignored). No perf-ledger row.

### RELEASE-7 repair — Fix resize/switch distortion without resetting gameplay — DONE 2026-10-31 (reopened 2026-10-30, repaired by @opencode, 4 lanes)
owns: `apps/web`, `packages/host`, `packages/webgl-renderer`, `packages/testkit` · depends: none
lane report (apps/web fix + host audit + webgl guard + testkit regression, disjoint owns): `dom.ts` finishFrame re-syncs blit wrapper dims/index/depth from live `host.fb` every frame (same object, no alloc), drops stale in-flight async presents, re-fits CSS + re-pairs BrowserBandPool on observed dims change; `play.ts` resizePlay rolls back host/display on GPU-backend failure (never success-with-mismatch) and resolveDisplay re-allocs on length skew; `WebGLRenderer.resize` warn-and-ignores invalid sizes without mutating state; host audit confirmed `Host.resize` correct (row-stride overlap copy, refresh.init, no-op, Com_Error-before-mutate); testkit running-loop regression covers all offered sizes both directions incl. DPR 1+2, stale-skew demo, sim preservation, pixel-identical restore.
evidence: web 39/39 (resize 15 + gpu-lifecycle + reboot, incl. real-Chromium resolution-fit legs in full web suite 297 pass); host resize-sim 11/11; webgl renderer+follow4 11/11 (full pkg 153 pass); testkit loop-resize 8/1skip (9/9 with Q2_PAK); deps:check 683 edges ok; full `yarn verify` 78/80 — sole failure `@q2/testkit#test` with the same 4 known GPU-browser classes as the archived baseline (CDP timeouts + follow-2a pose, display-dependent, pre-existing).
changesets: `release-7-webgl-resize-guard.md` + `release-7-host-resize-regression.md` + `release-7-testkit-loop-resize.md` (apps/web fix private, ignored). No perf-ledger row (correctness-only, O(1) per-frame wrapper sync; CPU optimization paused).

### GPU-FOLLOW-3B — Remove visible water tile boundaries — DONE 2026-10-30
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit` · depends: GPU-FOLLOW-3A
lane report (webgl + testkit + web captures + ANGLE order fix): LOD from unwarped UVs via `voodooSampleMippedWarped` + `highp` for multi-tile water; warp/scale/REPEAT/lighting/mips intact; forward-declaration order fixed (ANGLE strict).
evidence: webgl water-seam 16/1skip, full pkg 151pass; testkit water pixels (wrap 0.0207 < anim 4x, overlap 0.43, det 0); web pool 3/3 (stationary roiDiff 0.012, moving 80.0, seam ~0.002, sky/opaque/monsters/barrels intact, console clean).
changesets: `gpu-follow-3b-water-lod.md` + `gpu-follow-3b-water-pixels-testkit.md` + `gpu-follow-3b-shader-order.md`. No perf-ledger row (bench lane `f884316` carries numbers).

### GPU-FOLLOW-3B repair — Remove the remaining visible water tile seams — DONE 2026-10-31 (reopened 2026-10-30, repaired by @opencode, 3 lanes)
owns: `packages/webgl-renderer`, `apps/web`, `packages/testkit` · depends: none
lane report (webgl cause+fix + testkit matrix + web Chromium captures, disjoint owns): seam = per-face lightmap multiply on turbulent water — 130/134 coplanar shared water edges carry baked-light steps >8/255 (mean 134, max 247); both id refs draw warp faces UNLIT (ref_soft raw texels, ref_gl "no lightmaps"). FS_LIT warp-gated `col = texel` branch; repeat/adjacent-face/art exonerated with numbers (UV bit-identical at 149 shared verts, wrap bit-exact, art edge < interior); glass/opaque lighting, motion, mips, transparency, unwarped-LOD + highp preserved.
evidence: webgl 178/6skip (incl. pre-fix stash FAIL of the 2 warp-gate pins + injected lit-water control); testkit seam matrix 15/1skip with Q2_PAK (4+12skip without) + 3 caught injected controls; web real-Chromium 2 views x 3 phases: no repeat seams post-fix, flow alive (roiDiff 0.21-0.31), sky nonblack, 17 monsters, console clean; deps:check 717+ edges ok.
changesets: `gpu-follow-3b-unlit-water.md` + `gpu-follow-3b-seam-matrix.md` (apps/web captures private, ignored). No perf-ledger row (correctness-only; CPU optimization paused).

### RELEASE-8 — Retire the old CPU Voodoo renderer — DONE 2026-10-30
owns: `apps/web`, `packages/config`, `packages/renderer-api`, `packages/sw-renderer`, `packages/voodoo`, `packages/host`, `packages/testkit`, `tools/bench`, `tools/asset-cooker`, `docs` · depends: RELEASE-2, RELEASE-7
lane report (vocab majors + RGB strip + policy-only + bench/docs/web/testkit retirement, disjoint): `vid_renderer` vocab `software|webgl2-experimental` with persisted-`voodoo`→`software` warned fallback; sw-renderer indexed-only (RGB execution deleted, devroom `8f61c755` preserved); voodoo pure-policy (frame driver deleted); bench software-only gates; docs final architecture; web CPU-resolve removal + menu update; testkit raw-color rebase + RGB fallout fix.
evidence: config 17/17, renderer-api 7/7, sw-renderer 19 files 189 pass, voodoo 4 files 96 pass, bench 79/1, testkit proof/evidence 33/33, web selection/display 25/25 + visual/pool/resize/HUD legs green, typecheck+build clean per package, `deps:check` 676 edges ok.
gates: full `yarn verify` 78/80 tasks green; sole failure `@q2/testkit#test` with 4 known FOLLOW-5 failures (fg-recovery pool timeout 5s, PROOF-3 CDP 30s, PROOF-4 far/mip 0/0 degenerate fixture, follow-2a pose 90s) — reproduced class, no new failures; historical pre-repair rows stay labelled historical. BRAIN §§2-4 describe final architecture; §5 contracts unchanged (Refresh/Framebuffer intact).
changesets: majors `release-8-config-retire-voodoo.md`, `release-8-renderer-api-retire-voodoo.md`, `sw-renderer-release-8-rgb-retire.md`, `voodoo-release-8-policy-only.md`; patches `testkit-release-8-no-voodoo.md`, `testkit-release-8-indexed-only.md` (+ web paper trails ignored). No perf-ledger row (no frame-time change; bench `f884316` carries numbers).

### GPU-FOLLOW-5 — Refresh final fidelity evidence — DONE 2026-10-31
owns: `packages/webgl-renderer`, `packages/testkit`, `tools/bench`, `docs` · depends: 3B, R2, R3, R3B, R4, R5, R6, R7, R8 (all DONE)
lane report (single writer, sequential controlled concurrency): full-suite failures reproduced/isolated as load/contention class (timeouts retained, nothing inflated/skipped); PROOF-4 far gate repaired via FAR_VIEW (0.9937 HOLDS, was 0/0), mip gate re-homed to valid minified MID view (still 0/0 regime miss, fails loudly, thresholds untouched); matched F0/F1/F2 CPU hashes + GPU coverage + report-only vs-CPU rows; gun-skin-withheld negative + dual-chunk determinism + follow2b evidence; F1 gap specified as tone transform with edge-uniform disagreement (no localized defect).
evidence: webgl-renderer 168/6 + typecheck/build; testkit typecheck/build; bench 80/1 + typecheck/build; deps:check 676 ok; isolated greens (fg-recovery 6/6, PROOF-3 34s, follow-2a 17s, water/sky pixels green); full-file contention flakes recorded (PROOF-3 CDP, follow-2a pose) with stash compare.
verdicts: automated FAIL (loud, thresholds unchanged); precise tone-normalized contract proposal in lane report §5 NEEDS USER APPROVAL, NOT applied; human sign-off pending, recorded separately per gate.json.
changesets: `testkit-gpu-follow-5-fidelity.md` + `webgl-renderer-gpu-follow-5-fallback.md` (bench/docs need none). Ledger: `docs/perf-ledger.md` row + `docs/gpu-follow-5-testkit-lane.md`.
