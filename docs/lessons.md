# Lessons — single-sim rule, play-verified gate, closed/open lists

> Extracted from BRAIN.md §15. Read before spawning gameplay lanes.

## 15. Pipeline lessons (batch #8, 2026-10-26 — read before spawning lanes)

Recurring user reports ("still not fixed") traced to ONE structural cause, not
bad lanes. Evidence, all in `apps/web/src/play.ts`:

1. **Two simulations.** The browser runs the server tick (`SV_Tick`, movers,
   triggers) AND a private driver sim (`PlacedMonster[]`, `barrels`, `bolts`,
   `monsterChaseMove`/`monsterLocomotion`, driver door touch). Rendering uses
   the driver sim only. So `packages/server` fixes (monster pursuit/stairs/LOS,
   `SV_SetPmoveWorldFromBsp` C-mask, spawn-drop masks) are invisible in the
   browser — green headless server tests, zero browser change. This is the
   recurrence engine for: enemies don't follow, secret clip (driver uses
   game-side mask-1 `setPmoveWorldFromBsp`, not the C-mask server version),
   doors already open, unshootable barrels.
2. **Render-vs-hit divergence.** Hit tests (`traceShot` point mask, segmentAabb
   boxes) run on different state/masks than what renders → visible-but-immune
   barrels, bolts that visually connect but don't damage.
3. **Mock-green tests.** Headless driver tests build synthetic states, never the
   real base1 tick loop; no playtest boots base1 through the DRIVER and asserts
   rendered-state outcomes (barrel dies when shot, monster closes distance,
   door re-closes).

**Rules from now on:**

- Single-sim rule: base1 gameplay state lives in ONE place. Until the driver
  is deleted in favor of the server sim (Phase 1 below), any `packages/server`
  behavior fix must include the `apps/web` driver wiring in the SAME PR
  (cross-package lanes allowed for this, reviewer checks both).
- `done` = play-verified: every gameplay card needs a driver-level base1 bot
  test (real lump, real tick loop, asserts on rendered/submitted state), not
  just package unit tests.
- No more symptom lanes on God-object `play.ts` without first checking which
  sim owns the behavior.

### Unification plan — base1 actually works (batch #8+; scope = first map)

Target: ONE simulation (`packages/server` authoritative, 10Hz tick, C-ported);
`apps/web` owns rendering + input + prediction + cosmetics only. JS port
(`../external/quake-2-JS`, `g_ai.ts`/`g_monster.ts`/`m_soldier.ts`) is the
behavior template; C source (`../external/quake-2-source`) is ground truth.

- [x] Phase 0 — kill the dual sim: delete driver's `PlacedMonster[]`/
- `monsterChaseMove` block/`parseExplosives`/`barrels`/`bolts`/driver door
- touch; server owns monsters (full think: ai_run-lite, M_CheckAttack-lite,
- fire events), barrels (damage/delay/`damageRadius`), bolts (edicts + touch),
- explosions + muzzle events; driver renders from server state, fires via
- server `SV_PlayerFire`. (Folds Phase 1: driver uses `SV_*` trace helpers.)
- [x] Phase 2 — combat numbers: hull-swept bolt spawn (no muzzle detonations),
- C damage/skill tables, crosshair-vs-view audit, TTK bot (≤4 point-blank
- blaster hits, soldier 30hp, medium skill).
- [x] Phase 3 — feedback correctness: `m_flash` muzzle offsets only, no
- eye-ending streaks, single duck state transition (hull/eye/predictor).
- Duck follow-ups from the Phase 3 report, closed here: `PM_CheckDuck` is now
- C-exact (hold + ON_GROUND, airborne hold stands — no self-sustain), and
- `CL_PredictPmove` seeds `pmFlags`/`grounded` from the snapshot, so ducked
- prediction matches the authoritative tick bit-for-bit.
- [x] Phase 4 — play-verified gate: base1 driver-level bot asserting rendered
- outcomes (barrels die, monster closes 300→100u, door re-closes, secret
- holds, TTK). No gameplay card closes without it.
- ENFORCEMENT (2026-10-26): the gate is blocking, not advisory. A gameplay
- card (`packages/game`, `packages/server`, `apps/web` gameplay behaviour)
- may move to `done` only when `apps/web/src/base1-gate.test.ts` is green on
- that PR (real base1 lump, real tick loop, asserts on rendered/submitted
- state). Reviewer checks the gate run; `yarn verify` must include it.
- Per-batch "Still open" tails elsewhere in §9 are SUPERSEDED by the single
- consolidated list below — do not add new per-batch tails, update this one.
- (Sweep 2026-10-26: every per-batch tail closed-per-code was deleted; every
- genuinely open item was moved here. §9 now has no competing tails.)
### Consolidated still-open (2026-10-26 regression + gameplay wave, single list)
- CLOSED: infantry sim (INFANTRY lite def + think/chase/locomotion, 5 base1
- infantries simulate); DM-only items in SP (server `inhibitedBySkill` +
- web skill gate); sky-hit silent free (server `SURF_SKY`→`surfaceFlags` +
- web live-explosions-only); `Entity.alpha`/`oldframe`/`backlerp` smooth
- explosions (additive frozen-contract evolution); in-canvas fps; renderer
- hot-swap (no reboot); machinegun per-shot kick walk; melee/grenade real
- sounds (`melee2.wav`, grenade attack).
- CLOSED 2026-10-26 (touch regressions): bolt nearest-wins (wall no longer
- shadows edicts in the same step — all 9 exploboxes die to the blaster);
- TRIGGER_SPAWN wake/use chains (pickup targets once, death fires target,
- dormant bodies SVF_NOCLIENT-until-woken — the t55 shotgun trap works);
- infantry renders on its own MD2/skin (not the soldier mesh).
- CLOSED 2026-10-26 (fidelity/process sweep): M1.2 follow-up (real
- MD2/SP2 parsers + web `registerPakModels` with per-monster meshes);
- M3.2 overdraw re-run on real base1 (M3.3 recalibration, 2.5× budget);
- M3.3 recalibration; M3.4 skybox/`registerPakModels`/tracers/`SURF_SKY`;
- M6.1 (`CL_Predict` hookup, movement interp, baked conchars, `r_brightness`,
- muzzle-dlight drain consumes + clears); M7.1 IndexedDB pak cache;
- batch #2–#7 tails (doors/trains/ships, viewmodel recoil + C gun placement,
- barrels/`damageRadius`, soldier/gunner combat tables, blaster ballistics,
- green-tracer single-source, glass graft, skill/resolution dropdowns);
- M7.2 viewmodel placeholder note (real `v_weap` MD2s render with a pak);
- batch #3 real-pak play-test note (box-critters, 2D gun, HUD noise,
- muzzle leak — all resolved).
- CLOSED 2026-10-26 (M5.3-depth): full monster AI depth — player-trail
- pursuit around corners (ring + lost-sight last-sighting/trail pursuit),
- M_CheckAttack chance/as-state table, soldier duck (dodge odds, duck hull +
- hold + duck-and-shoot), combat points (spawn/hookup/chain/hold + anti-stack
- separation; base1 links zero combattargets), skill-scaled aggression
- (sight delay, burst refire, dodge chance; damage still half-only on easy).
- Gate (i/j/k) green, (b)/(e) adapted to the authentic cadence/duck; narrowed
- remainder: the lasfly loop only — the M_MoveToGoal sidestep probes LANDED
- 2026-10-26 (corner-stuck fix): the ai_run `new` course correction (TEMP
- sidestep on freshly adopted legs, dust-winner rejection) plus the
- SV_NewChaseDir-lite heading sweep with committed chirality in locomotion
- (opt-in; duck-aware step hull). Blind pursuit now rounds wall faces
- around their ends instead of hugging/pressing them; pinned by
- `monster-corner.test.ts` (L-wall: reaches last sighting blind, crosses
- the wall plane, closes 291u to engagement). Root cause was the missing
- probe, not the movestep (C SV_movestep has no slide — corners come from
- the probe + NewChaseDir sweep, both now ported).
- OPEN (perf/scope remainder): 60fps @640×480 software needs the browser async-render follow-up (M8.1 note); saves/menus/multiplayer stay out of scope (multiplayer explicit non-goal).
- CLOSED 2026-10-26 (doors/paths C-parity): func_door_secret / rotating
- doors, Think_CalcMoveSpeed, func_train_find path corners (synthetic unit
- tests in `packages/server`; base1 ships none — C-parity for other maps).
- CLOSED 2026-10-26 (stop-jitter residual): sub-tick prefix replays
- overshoot the 100ms friction step they prefix (front-loaded decay) and
- snap back ~0.5u at the stop boundary — `CL_Predict` now blends linearly
- to the server-exact tick end (one `SERVER_DT` step with the latest staged
- cmd); production-faithful stop shows 0 backward steps and 0.0 post-settle
- displacement (was 4 snap-backs, max 0.54u); base1-gate 11/11 green.
- CLOSED 2026-10-26 (canvas pointer-lock): config-menu clicks no longer
- fire the weapon. `attachToCanvas` (`packages/input/src/dom.ts`) listened
- for `mousedown` on `document`, so any UI click (cvar panel, dropdowns,
- buttons) set `+attack`. Mouse fire/look are now gated on
- pointer-lock-on-canvas; the lock-acquiring canvas click is swallowed,
- Esc/unlock clears held fire via `pointerlockchange` (no stuck attack),
- mouseup stays document-global, keyboard flow unchanged. Regression test
- `apps/web/src/canvas-lock.test.ts` (panel vs canvas synthetic events).
- CLOSED 2026-10-26 (monster attack-timing reconciliation): the 5 red
- devroom engagement pins + the pak-only M7.1 follow predated single-sim
- (red since Phase 0/3); behavior proven C-correct (HuntTarget 1s hold,
- M_CheckAttack NEAR 0.1/frame vs 122u/s run, melee plant, same-frame bolt
- move per g_main.c/G_RunFrame), so the pins now assert closes-then-engages
- (blind legs hold run with no shot; sighted bodies close 50u+ then volley
- at melee; streaks stay short/muzzle-origin/never eye-ending).
- CLOSED 2026-10-26 (explosive damageability): func_explosive takes direct
- fire (clip-attributed SOLID_BSP touch: `SV_ClipTrace` reports the winning
- clip's edict as `entityNum`, bolts/pellets damage that brush instead of
- detonating on an anonymous wall — the old tie always went to the wall, so
- funcs were immune) + radius via the C `CanDamage` MOVETYPE_PUSH self-hit
- rule, and `points <= 0` falloff deals nothing (dmg-0 blasts chip nothing,
- per g_combat.c). Blown brushes drop their clip, so the *20 corridor and
- the *30 slab walk open; debris stays visual-only (never in any clip).
- Gate (l)/(m)/(n) green: blown-door walk + crouch/stand/move-out on the
- debris (never stuck), crawlspace barrels + *30 slab die to blaster fire,
- all 9 exploboxes rest on the hull-trace floor (server origin and rendered
- mesh bottom within epsilon). (a) now pins the authentic opener chain
- (spawn pair 28 debris + *20 wall 24 = 52). Adjacent quirk, NOT this lane
- (needs a @q2/bsp or @q2/game owner): a hull parked EXACTLY on the plane
- reads allsolid (C-identical `d1 == 0` + ±1 leaf expansion in the
- position-test special case), so an exact-plane teleport can't stand back
- up — real falls rest at +1/32 and stand fine. Gate (l) settles from above
- to play it the way the engine does.
- CLOSED 2026-10-26 (movement/physics lane: walkable debris, crawlspace
- clip, water jump, drowning): blown brushes free + drop their clip on the
- SAME fuse tick (C `BecomeExplosion1` atomicity — the old damage-time free
- left a 2-tick invisible wall); `PM_CheckDuck` eye is the C `-2`
- (feet+22, not +12 — the old height parked the camera inside crawlspace
- ceilings: see-through + items-above + void orange; renderer untouched,
- diagnosis only) with the C `!allsolid` stand-up check; the out-of-water
- vault probe was inverted (vaulted in open water, never at a wall) — now
- C-exact via a solid-aware contents hook (dry-land traces bit-identical),
- vault branch runs C gravity + fall-cancel, and `pm_time` expiry clears
- WATERJUMP/LAND/TELEPORT (a hard landing previously latched TIME_LAND
- forever — jumping never worked again); `P_WorldEffects` drowning ported
- (air grace, 4,6,8…15 ramp at 1/s, gasp/watr/burn/drown/gurp hooks via
- existing damage/sound events, `playerAirLeft` exposed for the HUD lane).
- Headless pins: blown-*20 walk-through standing + crouched + sprint/16ms
- + soldier pursuit (`debris-water.test.ts`), waterjump single-impulse +
- vault-needs-wall (`water.test.ts`), crawlspace eye under the roof,
- drowning ramp. Gate (l) viewheight pin updated -2, 17/17 green.
- CLOSED 2026-10-26 (browser drowning, water lane): the web driver now
- installs the solid-aware `bspPointContentsFor` for `setPmoveWorld` AND
- passes it as `contents` into every `SV_Tick`, so `stepWorldEffects`
- samples the real base1 leaves in-browser (the tick fell back to the null
- `SV_WorldContents` before and early-returned — the browser never drowned).
- Play-verified in the driver loop (`drowning.test.ts`, real low-road pool:
- waterlevel 3, airLeft 12s grace, 4,6,8…15 ramp at 1/s, watr_in/gurp/gasp
- hooks, resurface recovery; vault engages at a real wall). Breather/
- envirosuit tail CLOSED by the sweep gameplay lane (see consolidated
- list): suits are items with 30s stacking timers, full P_WorldEffects
- immunity, breath/airout hooks and HUD-exposed seconds.
- CLOSED 2026-10-26 (HUD lane, reverses 105ff90): `fps N` (gated by
- `cl_showfps`) renders top-right INSIDE the framebuffer and `pos x y z yaw
- <yaw>` (gated by `cl_showpos`, default ON) top-left INSIDE the framebuffer,
- both via conchars glyphs (`drawString` in `drawPlayHud`'s pre-blit HUD pass,
- after the `r_brightness` scene lift, so colours stay authored and legible
- at default brightness). The DOM `#q2-fps`/`#q2-pos` overlays and their
- updaters are deleted (gates unchanged, just the sink); menu clicks stay
- input-free under canvas pointer-lock.
- CLOSED 2026-10-26 (window/corpse content lane): the spawn-room "third
- barrel" is func_explosive *20 (lump: 2 misc_explobox at (136,40,0) +
- (184,-24,0), 1 func_explosive *20; *30 is the second brush). Barrel MD2
- proxies render ONLY for genuine misc_explobox (9 live); both func
- explosives render their brush models via the mover graft (DoorSync +
- leaf facelists, closed pose at spawn) and ungraft on free
- (hideFreedBrushes). Damage path untouched (e2227bb kept — all 3 still
- chain the opener). *20 is all-TRANS33 e1u1/wndow0_3 glass (flags 0x10,
- 17 faces), rendered through the same world path as all base1 glass; no C
- spawnflags on either brush (TRIGGER_SPAWN/EF_ANIM inapplicable). 12
- misc_deadsoldier spawn per C (SOLID_BBOX 32x32x16, MOVETYPE_NONE,
- SP-only) and render the deadbod dude MD2 at lump origin + yaw with the C
- pose frame (spawnflags bits first-match-wins → 1..5, else 0), persisting.
- Gate (o)/(p) pin it (16/16 green); (g) 232 → 332, (n) 11 → 9.
- CLOSED 2026-10-26 (combat/movers feedback lane): soldier last-ditch
- death fire renders (C m_soldier.c death1 frames 21/24 = soldier_fire6/7,
- the only armed death move; gunner/infantry deaths all NULL): lite death1
- table tags 21/24 'fire', deathFireEvent emits a skin-gun event through
- the live resolver (foe bolt + muzzle + tracer + damage, unconditional
- like C), corpse stays hittable/gibbable (re-hit holds, overkill minces).
- Exit lift never starts from its door (C door_go_up fires on open-start,
- named trains wait for use; base1 plug *31 carries no target so no
- cascade reaches t91 — real-data audit proves only t91 starts it):
- door-open pins + 120-targetname no-fan-out audit. Gate (q) pins the
- rendered death bolt + muzzle in the death-frame 21/24 window (17/17).
- CLOSED 2026-10-26 (movers/clip lane): elevator parked on door-open
- (DRIVER-LOOP proof, not a server BFS: touch-open + walk-in + ride/board
- attempts + button approach + combat soak — no t91, *12 origin (0,0,0),
- mesh offset 0 while the plug/doors cycle; the only exit motion is the
- C-correct *31 descent; mesh tracks sim bit-exactly on a legit ride) and
- the -384,33 debris glue (live func_wall *9 slab, not leftover: the clip
- sweep lacked the C DIST_EPSILON enter bias, so clip landings rested
- exactly on contact — a C-unreachable allsolid state; world landings rest
- +1/32. Bias ported from CM_ClipBoxToBrush, landings +1/32 grounded).
- Gate (r)/(s) pin it (19/19 green); west of the spot the world rock face
- at x=-412 holds per the C trace rule (stays).
- CLOSED 2026-10-26 (movers lane, exit-lift auto-cycle): the doors at
- (-1669,1514,120) cycled open/close forever with the player standing
- still (7 *33 cycles in 400 driver ticks). Root cause in
- `SV_TouchDoorsAt` (packages/server/src/index.ts): the slider trigger
- volume followed the moving door (live-origin offset) while C
- `Think_SpawnDoorTrigger` bakes ONE static trigger from the rest bounds,
- so the slab slid out from under the camper, the TOP wait expired, and
- it re-touched in a loop; the touch also re-ran `moverUse` from WAITING
- every tick (zero-leg restart → per-tick target re-fire + door-sound
- edges) where C `door_go_up` on TOP only resets the wait. Fixed volumes
- + new `doorTouchUse` (packages/server/src/doors.ts: UP no-op,
- TOP/WAITING full-wait reset, BOTTOM/DOWN start the UP leg + fire the
- target once, TOGGLE reverses at TOP); rot branch now reaches TOP bodies
- too (rotUse already encodes the C reset). base1 ships no func_plat and
- no TOGGLE sliders; *32's t75 target dangles, so no cascade existed.
- Gate (t) pins it in the driver loop: 400-tick camp parks all three
- slabs open (offsets frozen, *12 never starts), then the *13 button
- chain runs the *12 train t88→t89→t90 once and it parks 150 ticks with
- nobody aboard (rendered/sim (-16,0,40)). 20/20 green; unit pins fail
- red pre-fix.
- CLOSED 2026-10-26 (infantry spin/cock lane): the spin is real
- (m_infantry.c `infantry_cock_gun`, attack1 frame 4 = attak104/md2 187:
- chaingun spin/crank, infatck3.wav, arms the 1.0–2.5s burst pausetime —
- NOT an attack2 wind-down). Full C combat catalogue audited against the
- lite tables: attack1 cock@3 + aimed fire@10 (attak111/md2 194) with the
- AI_HOLD_FRAME burst, attack2 swing@2 (infatck2, no damage) + smack@5,
- death2 "Off with his head" 12-round spray on death211–222 (md2 155–166,
- flashes 27–38 via aimangles[]). Implemented in-lock: tables tag all of
- the above (C frames cited), `deathFireEvent` synthesizes the death2
- spray through the live resolver (12 foe muzzles/tracers/sounds, 36
- damage, unconditional like C); the old "infantry deaths never fire"
- comment corrected (death1/death3 stay silent). Headless pins: attack1
- pass fires exactly once on frame 10, cock frame emits nothing (no
- fabricated bullet).
- CLOSED 2026-10-27 (sustained-fire lane): the deferred cock/hold gap is
- implemented — cock emits infatck3 at frame 3 + arms the C pausetime in
- the tick (`armInfantryCock` + `burstHoldFrozen` freeze on attack1 frame
- 10, `packages/server/src/index.ts` think hunk), firing one 3dmg bullet
- per 10Hz tick through the expiry tick (n-6 = 4-19 rounds at skill 1,
- same canSee gate as live fire). Same lane ports the C ss burst:
- skin-aware attack pick → attack4 strafe (6 frames, fire idx 2 =
- attak403, flash MZ2_SOLDIER_MACHINEGUN_4) with the
- (3+rand%8)*FRAMETIME hold (k+1 = 4-11 single 2dmg bullets, solatck3 per
- shot) replacing the fabricated same-tick 3-round fan — the user-visible
- "spinning gun for seconds" is the infantry chaingun (cock + 1.0–2.5s),
- the ss has no wind-up (C soldier_attack goes straight to attack4).
- New `burstHeld` mirrors C AI_HOLD_FRAME exactly (freeze, expiry bullet,
- move-switch clear). Headless pins (game/server): ss 9-event pass at
- 10Hz + 5-round/10dmg skill-1 damage pin, infantry 19-event pass with
- cock preceding; gate (e)/(i/j/k) and full base1-gate 20/20 green.
- OPEN (demo1 fallback): procedural devroom + fixed cameras wired; real `demo1.dm2` playback needs retail assets (Q2_PAK-gated, future work).
- OPEN (M4.1 review): harness landed but no real Voodoo3 capture yet — human review pending (done-when box stays unchecked).
- CLOSED 2026-10-26 (surface-cache ledger, render/process sweep): base1 sweep flythrough steady state 100% (9107 hits / 0 misses / 0 evictions, §11 row) — closes the M3.2 done-when; the raw 4-teleport union exceeds the 4MB budget and re-thrashes (~6%, expected by construction).
- CLOSED 2026-10-26 (glass translucency, render/process sweep): SURF_TRANS33/66 ported (deferred alpha pass, blend + stipple, `r_translucency`/`sw_stipplealpha` cvars; devroom `8f61c755` byte-exact; base1 pool-water golden `06456518` with the real alphamap; the 17 *20 TRANS33 faces live in brush-model *20, unreachable from the worldspawn tree, so they ride the same SPAN_TRANS33 code once the web mover graft submits them).
- CLOSED 2026-10-26 (process boxes, render/process sweep): CI runs node 20+22 `yarn verify` + `yarn deps:check` + PR changeset check; `yarn deps:check` enforces §4 (checker + documented exceptions) — closes the M0.1/M0.2 boxes.
- CLOSED 2026-10-26 (sweep gameplay lane, this card): (1) driver channel
- names are the real pak lumps (doors/dr1_strt.wav, switches/butn2.wav,
- items/pkup.wav, banded player/male/painN_M.wav + deathN.wav with the
- health<-40 udeath gib branch, C `*gurpN` resolved to the male fallback
- at emit) — M7.2 bot-test assertions updated, and a Q2_PAK test asserts
- every emitted name resolves + its wav header decodes; (2) corpse
- overkill-mince wired (bolt/pellet sweeps hit misc_deadsoldier hulls
- nearest-wins; SV_DamageDeadsoldier minces past -80 through the shared
- gib pipeline, corpse persists and re-gibs — C has no G_FreeEdict;
- play-verified gib-overkill bot test); (3) breather/envirosuit are items
- (30s stacking Use_* timers, pickup arms directly — no inventory UI),
- with P_WorldEffects immunity (protected air, alternating breath pair,
- enviro lava 3->1x + slime immunity, airout fade warning) and
- HUD-exposed seconds (expose only); play-verified breather bot test;
- (4) yaw (only yaw) interpolates between 10Hz ticks (C LerpAngle in
- @q2/client; driver prev-tick yaw + render-cadence frac, monotonic and
- bounded by the live yaw; position stays predictor-owned; no §6
- contract change; `play.ts` TODO(interp) closed).
- NOTE (cross-lane, for the rider/button lane): gate (t) currently fails
- with that lane's in-progress SV_CarryRiders hunk in the tree (exit *33
- never opens in the 400-tick camp); with HEAD play.ts + this sweep's
- changes (t) is green — evidence in the sweep report. Not touched here
- (out of this lane's lock).
- CLOSED 2026-10-26 (menu/HUD lane, checkboxes + pos readout): every
- boolean cvar in the config panel is a checkbox (15 in `CHECKBOX_CVARS`:
- `cl_showfps`/`cl_showpos`, all eight 0/1 `vd_*` fidelity switches,
- `r_drawworld`/`cl_predict`/`cl_interp`, `sw_wasm`/`sw_accum`; stale 0/1
- `CVAR_OPTIONS` entries removed, `sw_workers` stays a select), labels
- left-aligned, every row carries its cvar-doc `title` tooltip
- (`cvarDescription` + `CVAR_DESCRIPTIONS`, strings verbatim from the cvar
- definitions). `pos` readout drops yaw (`pos X Y Z`, 3-arg
- `formatPlayerPos`) in dim grey `POS_GREY 0xff999999` (replaces
- `POS_YELLOW 0xff66ffff`; one step above the `dim` crosshair tone, still
- painted post-`r_brightness`-lift so the display test's exact-colour pin
- at 2.0 holds). Checkbox sweep test: toggling any checkbox fires nothing,
- requests no lock, leaves no document listeners.
- CLOSED 2026-10-26 (perf lane, browser 20fps → async + hot paths):
- serial cull hot-path opts (flat frustum / style-hash memo / affected
- bsearch, all byte-identical: GEO 15.2→13.4ms interleaved A/B); browser
- async wired (`renderViewAsync`/`endFrameAsync`, `BrowserBandPool`,
- `frameAsync` ≡ `host.frame` differentially pinned, `resolveDisplay`
- live-plane fix) but the dom.ts rAF tick adoption + `blitToCanvas`
- copy-loop (~2.4–3.5ms) stay with the web lane (file lock); two probed
- non-wins reverted (SpanList window no-op, emitter reciprocal breaks
- goldens); play-level bench split committed (tick/pumps/render/HUD/
- blit-copy); M9.1 closed as composition-supersedes. `yarn verify` red
- ONLY from the server lane's uncommitted burst/gate work (combat burst +
- gate (u)/(v) fail identically without this lane's files — stash-proven);
- this lane's packages are green (sw-renderer 172/172, web async/display
- pins green, goldens `8f61c755` + base1 ×4 views identical).
- CLOSED 2026-10-27 (movers/boarding lane — rideable elevator): the
- fall-through had three compounding causes, all in the DRIVER path (the
- server mechanisms already existed): (1) movers/trains/plats were never
- solid to the driver trace (`SV_ClipTrace` only knew func_explosive/
- func_wall — the parked lift had a mesh but no sim clip, so riders fell
- straight through to the pit); now displaced mover/train brush boxes ride
- in the trace and the clip owns the hit, so pmove's `groundEntity` links
- riders to the pusher (ge=119 proven live on the parked *12); `func_plat`
- records bounds like doors. (2) `SV_CarryRiders` (M7.4's 272u server-side
- proof) was never called in the driver loop; the driver now carries
- post-`SV_Tick` (exact — a pre-tick carry lags one tick, measured -4u at
- the 40u/s train speed), gated to feet-on-top riders (pre-move top ±1u)
- so side-leaning bodies are left behind C-style instead of riding away
- (the exit-hall camper no longer rides the opening *32 slab south, which
- had broken gate (t)). (3) no button path existed: new `buttons.ts`
- C-parity helpers (`button_touch`/`button_use`/`button_fire` incl. wait/-1
- hold, UP/TOP no-op) with `SV_TouchButtonsAt` (contact press — 1u slop over
- the 1/32 lean rest, otherwise walk-ins never press, exactly like C's
- trace.ent touch) and `SV_UseButton` (E key: reach 96 + facing cone +
- wall-checked LOS, only the aimed button fires). Driver wiring is
- `play.ts` boarding/use/ride ONLY. Gate (u): walk-board the parked DOWN
- plug (feet==top 88, grounded, ge=plug, no fall-through) + footprint-place
- the parked train, E-call *13, ride the full t88→t89→t90 leg with
- feet==top (+1/32), grounded, ge=train every tick and the render tracking
- the sim bit-exactly, arrival (-16,0,40), 150-tick park.
- Gate (v): reach gate (350u: no fire), facing gate (level gaze away: no
- fire), aimed *13 press fires t91 (train runs to arrival, wait -1 holds
- TOP at offset (0,0,4)), *34 walk-touch fires t4 and the button cycles
- back to BOTTOM (wait default), per-window no-fan-out audit (t91 ∌ t4 and
- vice versa — ship pathtarget relays are ambient and excluded by window).
- Base1-gate 22/22 green (20 existing incl. (c)/(r)/(t) untouched). Geometry
- finding (evidence in the lane): the parked *12 sits under sealed world
- rock (point-hull rays hit the east face at x=-2048 and the ceiling flush
- at z=0; exhaustive placement sweep finds no 32-wide hull resting on the
- top without embedding — C-identical), so walk-boarding the train is
- impossible in any engine and (u) boards by footprint placement exactly
- like gate (t); every verdict is a real driver-loop outcome (fails pre-fix
- on ge + carry). This supersedes the cross-lane NOTE above (gate (t) is
- green WITH the carry in-tree via the feet-on-top gate) and the "verify
- red" attribution there ((u)/(v) are green; the remaining red —
- combat.test.ts ss-burst in devroom — touches none of this lane's paths:
- devroom spawns no movers (TouchButtons/carry/clip loops all no-op) and
- the test never sets BUTTON_USE, so it cannot execute this lane's code).
- CLOSED 2026-10-27 (pooled ordering — the "doll-house" black frame): the
- deferred async kick's lazy per-band clear wiped everything drawn before
- it, so staging-exhausting views (whole map visible) lost the world in the
- live browser loop, and the translucent alpha loop (drawn pre-kick) vanished
- nondeterministically on pooled paths. Fixed in-lock: foreground draws
- after the kick (`drawForeground` split out of `renderView`, sync order
- unchanged), deferred breaks replay inline and latch inline-rest (no
- trailing kick to wipe them), alpha runs first in the foreground, and the
- parallel resolve never clears (freshness owned by raster kicks). Pins:
- pooled async vs sync with world alias and depthHack gun (both fail
- pre-fix), pooled sync/async vs classic on TRANS66 pool water (fails
- pre-fix on both pooled paths); 135-view base1 corner sweep async-identical
- to sync with classic walk hashes unchanged. Browser workers run
- `render-worker.ts` from source (vite), so no dist rebuild is needed for
- the live loop; headless pool tests run the rebuilt `dist` bundle.
- CLOSED 2026-10-27 (async foreground wipe — the missing hand gun):
- `renderViewAsync` drew the entity foreground BEFORE the deferred pooled
- world kick, whose lazy per-band clear wiped every direct plane write
- (world alias, entities incl. the depthHack viewmodel gun, sprites,
- particles, tracer beams). Latent since the async primitives landed (all
- async goldens ran entity-free: `renderAsync.test.ts` passed `[]`), live
- since the browser rAF tick adopted `frameAsync`. `renderView` is split
- into world pass + `drawForeground` (sync: inline, bit-identical; async:
- after `flushAccumAsync`). Regression pins: pooled async vs pooled sync
- with world alias and with a depthHack gun entity (both fail pre-fix with
- the foreground wiped, green post-fix). Web base1-gate 23/23 green.
