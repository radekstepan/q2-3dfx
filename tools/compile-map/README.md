# tools/compile-map — Quake II `.map` → `.bsp` toolchain

`compile.sh` runs the reproducible pipeline (static source check → `qbsp`
geometry → `qvis` visibility → `qrad`/`light` lighting), fails loudly on
tool errors or leaks, and records `build/provenance.txt` (tool versions,
map hash, commands). `check-map.py` validates `.map` source without any
compiler binary (brace balance, face syntax, outward-facing planes,
required entities).

## Tool evaluation (2026-11-01, this environment)

Probed with `./compile.sh --probe-only` (also `which`, `apt-cache search`):

| Tool | Q2 BSP38? | License | Status here |
| --- | --- | --- | --- |
| id Quake 2 tools (`qbsp3`, `qvis3`, `qrad3`) | Yes (reference Q2 toolchain) | GPL-2.0 (id source release) | **Not installed** |
| Community Q2 forks (`qbsp`/`q2bsp`/`q2map` variants) | Varies by fork — verify BSP version 38 output | Varies (usually GPL) | **None found** (`qbsp qbsp3 q2bsp q2map qvis qvis3 qrad qrad3 arghrad`: all missing) |
| ericw-tools (`qbsp`, `vis`, `light`) | **No** — Quake 1 / Hexen 2 only (Q2 support is experimental, light-only per upstream history) | GPL-2.0 | Not installed; **do not use for Q2 BSP38** |
| TrenchBroom (editor) | N/A (authoring; has a Q2 game config, writes standard + Valve-220 `.map`) | GPL-3.0 | **Not installed** |
| DarkRadiant (`apt`) | No — Doom 3 / Dark Mod only | GPL | Available in apt; irrelevant for Q2 |
| yamagi-quake2 (`apt`, installed here) | N/A — engine, ships no compile tools | GPL-2.0 | Installed; not a compiler |

Bottom line: **no Q2 compile toolchain exists in this environment**, so
`maps/first-map` ships as validated source only (see below). The pipeline,
probe, and dry-run output are fully scripted so a manual build is
mechanical once tools are installed.

## Installing a toolchain

1. Preferred: id's Quake 2 tools (`qbsp3`, `qvis3`, `qrad3`) or a
   maintained Q2 fork that emits BSP version 38. Build from source per
   that project's instructions (all are GPL; keep the license text with
   any redistribution).
2. Authoring: TrenchBroom with its Quake 2 game configuration. Save maps
   in **Standard** `.map` format, not Valve 220, unless your `qbsp`
   documents Valve-220 support (classic `qbsp3` does not read it).
3. Verify the install: `./compile.sh --probe-only` must show all three
   stages FOUND, with versions.

## Usage

```bash
# Static source validation only (no compiler needed, CI-safe):
tools/compile-map/compile.sh --check-only --map maps/first-map/first-map.map

# Show the exact commands a real build would run:
tools/compile-map/compile.sh --dry-run --map maps/first-map/first-map.map

# Full build (requires the toolchain above):
tools/compile-map/compile.sh --map maps/first-map/first-map.map
# Fast unlit/unvis'd iteration builds:
tools/compile-map/compile.sh --map maps/first-map/first-map.map --skip-vis --skip-light

# Point at non-PATH binaries / pass extra flags:
QBSP_BIN=/opt/q2tools/bin/qbsp3 QBSP_FLAGS="-verbose" \
  tools/compile-map/compile.sh --map maps/first-map/first-map.map
```

Output lands in `maps/first-map/build/` (gitignored): `first-map.bsp`,
`compile.log`, `provenance.txt`, plus `.pts`/`.lin` leak pointfiles when
the map leaks (load them in TrenchBroom to trace the leak).

## Compiled output policy

**Do not commit compiled `.bsp` files.** `maps/*/build/` is gitignored:
the `.map` source plus `provenance.txt` command lines reproduce the build
bit-for-bit given the same tool versions. Compiled maps that reference
id textures additionally require the user-supplied PAKs and must never
be redistributed.

## `maps/first-map` status

- Source: `maps/first-map/first-map.map` — 25 brushes, 7 entities,
  original `q2ts/` texture namespace (no proprietary assets).
- `check-map.py --strict`: **passes** (outward-facing planes verified
  against the `cross(p3-p1, p2-p1)` outward rule, worldspawn + player
  start + 5 lights present). A flipped-winding mutation was verified to
  fail the checker.
- `qbsp`/`qvis`/`light`: **not run** — no toolchain in this environment.
  Pending: compile with zero leaks/errors, then viewer + game verification
  per `docs/map-authoring.md`.
