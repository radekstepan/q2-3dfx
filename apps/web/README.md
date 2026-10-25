# web

Playable browser shell: canvas, HUD, pak drop zone, renderer switcher, cvar
panel, `requestAnimationFrame` loop (`apps/web`).

## What it is

`index.ts` auto-boots on a DOM: procedural devroom with no assets, real
`maps/base1.bsp` when the user drops `pak0.pak`. `play.ts` owns the
server-authoritative `LocalDriver` (BSP pmove collision, doors/triggers/
movers, static shootable monsters, blaster/shotgun/machinegun hitscan,
exit detection); `dom.ts` owns the rAF loop, pointer-lock input, HUD blit,
voodoo resolve, and gesture-unlocked sound. All engine imports resolve to
real ESM (`dist/index.mjs` via `exports`, no Vite pre-bundling needed).

## Public API

- `bootWeb({ width?, height?, renderer?, pak?, nowMs? }): BootResult` —
  headless-safe boot to first frame (used by tests and Node).
- `bootPlay({ width?, height?, renderer?, pak? }): PlayBoot` — real
  `SoftwareRenderer` + `LocalDriver` + display buffers.
- `startPlayLoop(canvas, boot, { pak? }): PlayLoop` (in `dom.ts`) —
  rAF driver: input attach, frame, voodoo resolve, HUD, blit, sound cues.
- `LocalDriver` (`play.ts`): `HostDriver` over devroom analytic collision
  (floor/walls/pillar swept-box trace) or `loadBsp` base1 (static BSP trace).
- `drawPlayHud` / `resolveDisplay` — crosshair + status lines, software or
  `vd_*` voodoo resolve path.

## How it is used

Browser: open the Vite dev server (`yarn start`), click the canvas for
pointer lock, WASD + mouse + Space/E + 1/2/3. Drop `pak0.pak` anywhere to
boot base1 (spawn, doors, exit trigger, 8 monster placeholders).

## Testing

`yarn workspace web test` — headless boot, devroom walk/collide/jump/shoot,
plus `Q2_PAK`-gated real-base1 walk-turn-shoot. Run with
`Q2_PAK=/path/to/pak0.pak`.

## Constraints

App leaf: composes engine packages, nothing imports it. Internal res is
320×240, CSS-upscaled 2× (base1 spawn view ≈10.8 ms/frame single-threaded;
640×480 needs the M8.1 worker bands). No saves, no menu, no monster AI yet.
