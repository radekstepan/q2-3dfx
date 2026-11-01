# Map viewer — inspect Quake II maps without gameplay

Standalone page under `apps/web` (`apps/web/src/map-viewer/`) that loads a
Quake II BSP38 map, flies through it with a free camera, inspects its
entities, and captures reproducible screenshots. It never starts a server,
spawns a player, or advances gameplay, so it can inspect maps even when an
entity or game feature is unsupported.

## Setup

```bash
yarn dev   # primary runtime; serves the game and the viewer
```

The viewer has its own HTML entry (`apps/web/map-viewer.html`, mounted at
`#mv-panel`, module `src/map-viewer/main.ts`) included in the Vite build
inputs alongside `index.html`. No PAKs or game assets are bundled or
required. All files stay local to the browser.

## Loading maps and assets

- **Standalone `.bsp`:** file picker and drag-and-drop. Unsupported BSP
  versions and malformed files produce a recoverable error naming the
  cause; picking another valid map afterward works.
- **Map inside a `.pak`:** select a local PAK, list its `maps/*.bsp`
  entries, and choose one.
- **Optional asset PAKs:** a standalone BSP can resolve textures and the
  palette from user-supplied PAKs. The page states the precedence when
  several are loaded (consistent with the game's lookup).

Missing assets never block inspection: unknown/missing textures fall back
to a clearly-marked fallback material, and the page shows the map name,
source, and a one-per-gap summary of missing assets (textures, palette,
lightmaps, visibility, spawn entities) instead of repeated warnings.
When an asset PAK (or the map PAK itself) carries `pics/colormap.pcx`,
the viewer installs that real palette — including C-exact blend tables —
instead of the procedural fallback; the status line reports
`palette: pak|procedural` so you can tell which is active.
Switching maps releases renderer resources and resets map-specific state.

## Controls and navigation

- Free-fly first-person camera: pointer-lock mouse look (click to capture,
  Esc releases), WASD movement, vertical movement keys, speed modifier.
  Movement is frame-rate independent and stops when focus is lost.
- The camera spawns at a player start when the map has one, otherwise at
  a deterministic fallback derived from map bounds; a reset action
  returns there.
- The HUD shows position and viewing angles in a copyable representation
  for reproducing views (see screenshots).
- A brightness slider (display-only, default 2.0 to match the game's
  `r_brightness`) lifts the presented image without touching the engine
  buffer or lightmaps — useful for inspecting dark sections. The value is
  shown in the status line.

## Inspection panel (`map-viewer/panel.ts`)

Collapsible `Inspection` panel, headless-safe (works with the repo's
fake-DOM test pattern):

- **Stats:** faces/brushes/leaves/models/entity counts (entity count comes
  from parsing the entity lump; lump byte length is shown for diagnostics)
  plus world-model bounds, or an explicit "bounds unavailable" note when
  the map has no models.
- **Entity list:** every entity by index with classname and origin where
  present; filter box matches classname substrings case-insensitively.
  Malformed entity lumps degrade to an empty list with a note — never a
  crash, never a half-rendered list.
- **Entity markers:** toggle for markers on entities with usable origins;
  `info_player_start` markers are distinguished. Brush entities (`*N`
  models) without origins and entities with unparseable/missing origins
  are listed as **unsupported with reasons** — no misleading markers are
  ever placed. Selecting an entity shows all its key/value pairs and
  offers "Go to" when (and only when) it has a usable origin.
- **Camera controls:** reset, origin + angles inputs with Apply (validated;
  rejected input explains itself), and Copy view, which copies the
  `map: … / pose: …` metadata described below (pose text stays visible for
  manual copy when the clipboard API is unavailable or denied).

Top-down overview is a deferred follow-up: it needs a separate design
choice (projected geometry vs. slice, multi-level readability) after the
first working viewer.

## Screenshots and repeatable review (`map-viewer/capture.ts`)

- `captureViewerCanvas(canvas, { mapName, poseText })` downloads the
  viewer canvas as `q2ts-mapview-<map>-<yyyymmdd-hhmmss>.png` and copies
  the reproducing metadata (`map: …` + `pose: …`) to the clipboard.
- It never throws: with no canvas, no download anchor, or no clipboard,
  the corresponding flag (`downloaded`/`copied`) is false while the
  metadata string is still returned so the page can display it for manual
  copy (documented browser fallback).
- Deterministic camera coordinates: `formatPoseText` /
  `parsePoseText` define the canonical `origin (x y z) angles (p y r)`
  fixture format; the parser also reads the shell camera's
  `origin x y z; angles p y r` spelling so Apply works against the live
  camera. Pass an explicit date for byte-stable CI filenames.
- Automated checks use a small synthetic BSP fixture plus deterministic
  poses — never the user's PAK. Real-map legs are opt-in via `Q2_PAK`
  and skip when it is absent, per repo convention.

## Sky

Sky surfaces (`SURF_SKY`) are hidden behind a flat very-light-grey
stand-in so openings read as contrast against the model. The stand-in
is installed from the PAK palette (indices are palette-relative, so a
palette must be present — otherwise the engine's flat-blue fallback
remains); `env/` sky art is deliberately never loaded. The status line
reports `sky: hidden (light-grey stand-in)`. Sky stays opaque — it is
drawn at infinite depth as the background — so this is a color choice,
not transparency.

## Asset requirements

- Nothing proprietary is required or bundled. The viewer works with zero
  assets (fallback rendering) and improves as the user supplies PAKs.
- Redistributable fixtures (synthetic BSPs, original `q2ts/…` textures)
  live in the repo; game PAKs and id textures never do.

## Enemies

Monster spawns (`monster_*` entities with usable origins) render as static
MD2s at their BSP spawn poses — the same soldier/gunner/infantry meshes and
PCX skins the game uses, resolved from the asset + map PAKs first-wins.
Unknown `monster_*` variants render with the soldier fallback mesh so mappers
still see the spawn. Anything without a usable origin is skipped (listed as
unsupported in the panel, never placed).

- Placement preview only: no AI, patrols, attacks, or animation — frame 0,
  yaw from the `angle`/`angles` keys. Verify behavior in the game, not here.
- Asset-free visibility: with no PAKs, spawns render with the engine's
  procedural mesh/checker skin instead of vanishing.
- Toggle: the `enemies` checkbox in the viewer bar shows/hides the installed
  spawns without dropping their handles; the status line reports
  `enemies: N (kind xN, …)` or `(hidden)`.
- Switching maps clears the previous spawn list; re-adding asset PAKs
  re-resolves MD2/PCX lumps for the current map without moving the camera.

## Known limitations

- **Static submodels:** brush models (doors, lifts, buttons) render at
  their static pose. The viewer does not simulate movers, game logic, or
  dynamic lighting — verify those in the game, not here. (Monster spawns
  are the exception above: posed MD2s, still without simulation.)
- **Missing assets:** unlit/unvis'd maps render, but lighting/PVS
  fidelity checks require compiled output (`tools/compile-map/`).
- **No collision:** the camera flies freely by design; walkability must
  be playtested in the game (see `docs/map-authoring.md` §5).
