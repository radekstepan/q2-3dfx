# Map authoring — creating Quake II maps for q2ts

How to write, compile, and test a Quake II BSP38 map with this repo.
Toolchain setup and script reference live in `tools/compile-map/README.md`;
this doc covers the authoring workflow end to end.

## 1. Write the `.map` source

- Author in TrenchBroom (Quake 2 game config) or by hand. Save in
  **Standard** `.map` format, not Valve 220, unless your `qbsp` documents
  Valve-220 support (classic `qbsp3` does not read it).
- Keep maps tiny and sealed: every playable space must be fully enclosed
  by structural brushes, or `qbsp` reports a leak (`.pts`/`.lin`
  pointfiles; a leak also voids the VIS stage).
- Brush planes: three points per face with `cross(p3-p1, p2-p1)` pointing
  **outward** (brush interior is the negative side). For an axis-aligned
  box `(x0 y0 z0)`–`(x1 y1 z1)`:
  - −X: `(x0 y0 z0) (x0 y1 z0) (x0 y0 z1)`
  - \+X: `(x1 y1 z1) (x1 y1 z0) (x1 y0 z1)`
  - −Y: `(x1 y0 z1) (x1 y0 z0) (x0 y0 z1)`
  - \+Y: `(x0 y1 z0) (x1 y1 z0) (x0 y1 z1)`
  - −Z: `(x0 y0 z0) (x1 y0 z0) (x0 y1 z0)`
  - \+Z: `(x0 y0 z1) (x0 y1 z1) (x1 y0 z1)`
- Required entities: `worldspawn` (the brushes live here), exactly the
  setup you intend for `info_player_start` (origin = feet position,
  `angle` = yaw in degrees, 0 faces +X), and at least one `light`
  (`light` key = intensity, e.g. `300`) or the map compiles fullbright.
- Movement budgets (Quake II): max walk step 18 units, max jump ~56 —
  keep risers ≤16 and landmark platforms clearly non-climbable or
  clearly stairs.

## 2. Textures and licensing

- `qbsp` only records texture names; it never opens `.wal` files, so a
  map compiles without any textures installed. At view/play time each
  `q2ts/name` texinfo resolves to `textures/name.wal` in the loaded
  PAKs, and missing ones render the viewer's fallback material.
- **Original maps must use an original texture namespace** (e.g.
  `q2ts/…`), never `e1u1/…` or other id names — both to avoid implying
  id assets ship with the repo and to make missing-asset fallbacks
  obvious during development.
- Never commit PAKs, extracted id textures, or compiled `.bsp` files
  that reference id textures. `maps/*/build/` is gitignored.

## 3. Validate and compile

```bash
tools/compile-map/compile.sh --check-only --map maps/first-map/first-map.map
tools/compile-map/compile.sh --dry-run --map maps/first-map/first-map.map
tools/compile-map/compile.sh --map maps/first-map/first-map.map
```

`check-map.py --strict` (runs first inside `compile.sh`) verifies brace
balance, face syntax, outward-facing planes, and the entity checklist —
it needs only python3, so it runs in CI. The remaining stages need the
toolchain from `tools/compile-map/README.md`:

1. `qbsp <map>` — geometry. Must exit 0 with no leak. On a leak, load
   the emitted `.pts`/`.lin` in TrenchBroom and seal the gap.
2. `qvis <bsp>` — visibility. Skippable for iteration (`--skip-vis`).
3. `qrad`/`light <bsp>` — lighting. Skippable for iteration
   (`--skip-light`; unlit maps render fullbright).

Each run writes `build/provenance.txt` (tool versions, map hash, exact
commands) — paste it into the PR when a compiled map is reviewed.

## 4. Load the result in the viewer

Open the map viewer page (see `docs/map-viewer.md`), pick the compiled
`build/first-map.bsp` via the standalone-BSP picker, and verify:

- Spawn view: the camera starts at (or reset-reaches) the player start
  with the corridor/landmarks visible; stats show 25 brushes, 7
  entities, world-model bounds matching the source.
- Connections: fly the corridor, climb the steps, enter the hall, and
  capture the spawn/corridor/hall viewpoints (Copy view) for the record.
- With textures absent the map must still be fully inspectable via the
  fallback material; the missing-asset summary must list the `q2ts/…`
  textures, not crash.

## 5. Load the result in the game (dev-only route)

The game boot path is hard-coded to `maps/base1.bsp` from the loaded
PAK (`apps/web/src/play.ts`, `LocalDriver`; `map_source` only toggles
`devroom` vs that one map). **There is no `?map=` parameter and no
arbitrary-map support in the game today — adding either would refactor
the boot path and is explicitly out of scope** (plan §6.4 follow-up).

Until that follow-up lands, playtest a custom map with a temporary local
copy only: build a throwaway PAK (or patch a local copy of the asset
flow outside the repo) that serves the compiled BSP under the expected
lump name, run the existing collision/navigation/lighting checks, then
throw the copy away. Never commit such a PAK or a renamed id map.

Gameplay acceptance for the first map: spawn without falling, walk the
corridor and steps (no snags), collide with walls/pillar/dais, and
confirm the lights behave (no fullbright surprise when lit was
requested). Record engine/viewer limitations separately from map
defects — in particular, brush submodels (doors, lifts) render static
in the viewer and need game-side movers to behave.

## 6. `maps/first-map` status

Deliberately small original map: spawn room → corridor → raised hall
(4×16-unit steps, 0→64), central pillar + hall dais landmarks, player
start facing the corridor, 5 point lights, `q2ts/…` textures.

- [x] Source committed, `check-map.py --strict` green (incl. verified
  flipped-winding rejection).
- [ ] Compile with zero leaks/errors (blocked: no Q2 toolchain in this
  environment — see `tools/compile-map/README.md` probe table).
- [ ] Viewer spawn/connections/overhead inspection + captured views.
- [ ] Game collision/navigation/lighting pass via the dev-only route.
